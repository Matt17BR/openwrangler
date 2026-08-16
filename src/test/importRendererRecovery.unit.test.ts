import { describe, expect, it, vi } from "vitest";
import { waitForImportRendererRecovery, type ImportRendererRecoveryApi } from "./extensionHost/importRendererRecovery";
import type { RendererSynchronizationReceipt } from "./extensionHost/acknowledgedRenderer";

const sessionId = "12345678-1234-1234-1234-123456789abc";
const retained: RendererSynchronizationReceipt = {
  sessionId,
  revision: 7,
  syncId: "0123456789abcdef0123456789abcdef"
};
const replacement: RendererSynchronizationReceipt = {
  sessionId,
  revision: 7,
  syncId: "fedcba9876543210fedcba9876543210"
};

describe("import renderer recovery", () => {
  it("observes complete retirement before accepting an exact new generation", async () => {
    let hydrated = true;
    let synchronizable = true;
    let receipt: RendererSynchronizationReceipt | undefined = retained;
    const testing: ImportRendererRecoveryApi = {
      panelHydrated: vi.fn(() => hydrated),
      panelSynchronizable: vi.fn(() => synchronizable),
      panelSynchronizationReceipt: vi.fn(() => receipt)
    };
    const onRetired = vi.fn();
    const waitForCondition = vi.fn(async (condition: () => boolean, _timeout: number, description: string) => {
      if (description.includes("invalidate")) {
        expect(condition()).toBe(false);
        hydrated = false;
        synchronizable = false;
        receipt = undefined;
        expect(condition()).toBe(true);
        return;
      }
      expect(onRetired).toHaveBeenCalledOnce();
      expect(condition()).toBe(false);
      hydrated = true;
      synchronizable = true;
      receipt = replacement;
      expect(condition()).toBe(true);
    });

    await expect(
      waitForImportRendererRecovery(testing, sessionId, 7, retained, {
        retirementTimeoutMs: 12_000,
        recoveryTimeoutMs: 30_000,
        onRetired,
        diagnostics: () => ({ sessions: 1 }),
        waitForCondition
      })
    ).resolves.toEqual(replacement);
    expect(waitForCondition).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      12_000,
      expect.any(String),
      expect.any(Function)
    );
    expect(waitForCondition).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      30_000,
      expect.any(String),
      expect.any(Function)
    );
  });

  it("does not accept hydration from the old generation, another session, or revision", async () => {
    let receipt: RendererSynchronizationReceipt | undefined;
    let hydrated = false;
    const testing: ImportRendererRecoveryApi = {
      panelHydrated: () => hydrated,
      panelSynchronizable: () => hydrated,
      panelSynchronizationReceipt: () => receipt
    };
    let phase = 0;
    const waitForCondition = vi.fn(async (condition: () => boolean) => {
      phase += 1;
      if (phase === 1) {
        expect(condition()).toBe(true);
        return;
      }
      hydrated = true;
      for (receipt of [
        retained,
        { ...replacement, sessionId: `${sessionId}-other` },
        { ...replacement, revision: 8 }
      ]) {
        expect(condition()).toBe(false);
      }
      receipt = replacement;
      expect(condition()).toBe(true);
    });

    await expect(
      waitForImportRendererRecovery(testing, sessionId, 7, retained, {
        retirementTimeoutMs: 12_000,
        recoveryTimeoutMs: 30_000,
        onRetired: vi.fn(),
        diagnostics: vi.fn(),
        waitForCondition
      })
    ).resolves.toEqual(replacement);
  });
});
