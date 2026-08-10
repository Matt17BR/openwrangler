import { describe, expect, it, vi } from "vitest";
import {
  waitForFreshExactSessionPanelHydration,
  type ExactSessionPanelSynchronizationApi
} from "./extensionHost/panelHydration";

describe("fresh exact-session panel hydration", () => {
  it("accepts the newly forced renderer generation without publishing a replacement", async () => {
    const sessionId = "session-a";
    let hydrated = false;
    const expectedRevision = 7;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async (candidate) => {
        expect(candidate).toBe(sessionId);
        hydrated = true;
        return true;
      }),
      ensurePanelSynchronized: vi.fn(async () => true),
      panelHydrated: vi.fn((candidate) => candidate === sessionId && hydrated),
      panelSynchronizable: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === sessionId && hydrated ? { syncId: "sync-a", sessionId, revision: expectedRevision } : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision,
        timeoutMs: 100,
        pollIntervalMs: 25
      })
    ).resolves.toBe(true);
    expect(testing.synchronizePanel).toHaveBeenCalledOnce();
    expect(testing.ensurePanelSynchronized).not.toHaveBeenCalled();
  });

  it("accepts exact-session hydration when a renderer pull supersedes both acknowledgement waits", async () => {
    const sessionId = "session-a";
    let now = 0;
    let hydrated = false;
    const expectedRevision = 7;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async () => false),
      ensurePanelSynchronized: vi.fn(async () => false),
      panelHydrated: vi.fn((candidate) => candidate === sessionId && hydrated),
      panelSynchronizable: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === sessionId && hydrated ? { syncId: "sync-a", sessionId, revision: expectedRevision } : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision,
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
          hydrated = true;
        }
      })
    ).resolves.toBe(true);
    expect(testing.synchronizePanel).toHaveBeenCalledWith(sessionId);
    expect(testing.ensurePanelSynchronized).toHaveBeenCalledWith(sessionId, 100);
    expect(testing.ensurePanelSynchronized).toHaveBeenCalledOnce();
  });

  it("waits for the panel to acknowledge the requested revision", async () => {
    const sessionId = "session-a";
    const expectedRevision = 7;
    let now = 0;
    let acknowledgedRevision = 6;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async () => true),
      ensurePanelSynchronized: vi.fn(async () => true),
      panelHydrated: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizable: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === sessionId
          ? { syncId: `sync-${acknowledgedRevision}`, sessionId, revision: acknowledgedRevision }
          : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision,
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
          acknowledgedRevision = expectedRevision;
        }
      })
    ).resolves.toBe(true);
    expect(testing.ensurePanelSynchronized).toHaveBeenCalledOnce();
  });

  it("does not accept a hydrated panel that stays on an older revision", async () => {
    const sessionId = "session-a";
    let now = 0;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async () => true),
      ensurePanelSynchronized: vi.fn(async () => true),
      panelHydrated: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizable: vi.fn((candidate) => candidate === sessionId),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === sessionId ? { syncId: "sync-6", sessionId, revision: 6 } : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision: 7,
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).resolves.toBe(false);
    expect(testing.ensurePanelSynchronized).toHaveBeenCalledOnce();
    expect(now).toBe(100);
  });

  it("allows the final recovery generation to hydrate after the ordinary operation deadline", async () => {
    const sessionId = "session-a";
    let now = 0;
    const expectedRevision = 7;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async () => false),
      ensurePanelSynchronized: vi.fn(async () => false),
      panelHydrated: vi.fn((candidate) => candidate === sessionId && now >= 13_000),
      panelSynchronizable: vi.fn((candidate) => candidate === sessionId && now >= 10_000),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === sessionId && now >= 13_000
          ? { syncId: "sync-a", sessionId, revision: expectedRevision }
          : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision,
        timeoutMs: 30_000,
        pollIntervalMs: 1_000,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).resolves.toBe(true);
    expect(now).toBe(13_000);
    expect(testing.ensurePanelSynchronized).toHaveBeenCalledWith(sessionId, 30_000);
  });

  it("does not accept another session's hydration while waiting for the requested renderer", async () => {
    const sessionId = "session-a";
    let now = 0;
    const testing: ExactSessionPanelSynchronizationApi = {
      synchronizePanel: vi.fn(async () => false),
      ensurePanelSynchronized: vi.fn(async () => true),
      panelHydrated: vi.fn((candidate) => candidate === "session-b"),
      panelSynchronizable: vi.fn(() => false),
      panelSynchronizationReceipt: vi.fn((candidate) =>
        candidate === "session-b" ? { syncId: "sync-b", sessionId: "session-b", revision: 7 } : undefined
      )
    };

    await expect(
      waitForFreshExactSessionPanelHydration(testing, sessionId, {
        expectedRevision: 7,
        timeoutMs: 100,
        pollIntervalMs: 25,
        now: () => now,
        wait: async (durationMs) => {
          now += durationMs;
        }
      })
    ).resolves.toBe(false);
    expect(testing.panelHydrated).toHaveBeenCalledWith(sessionId);
    expect(testing.ensurePanelSynchronized).not.toHaveBeenCalled();
  });

  it("bounds an unresponsive forced synchronization by the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      const testing: ExactSessionPanelSynchronizationApi = {
        synchronizePanel: vi.fn(() => new Promise<boolean>(() => undefined)),
        ensurePanelSynchronized: vi.fn(async () => true),
        panelHydrated: vi.fn(() => false),
        panelSynchronizable: vi.fn(() => true),
        panelSynchronizationReceipt: vi.fn(() => undefined)
      };
      const pending = waitForFreshExactSessionPanelHydration(testing, "session-a", {
        expectedRevision: 7,
        timeoutMs: 100,
        pollIntervalMs: 25
      });

      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toBe(false);
      expect(testing.ensurePanelSynchronized).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
