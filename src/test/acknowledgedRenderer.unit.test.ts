import { describe, expect, it, vi } from "vitest";
import {
  exactSessionApp,
  reacquireAcknowledgedSessionApp,
  sameRendererSynchronizationReceipt,
  type AcknowledgedRendererApi,
  type RendererSynchronizationReceipt
} from "./extensionHost/acknowledgedRenderer";

const sessionId = "12345678-1234-1234-1234-123456789abc";
const receipt: RendererSynchronizationReceipt = {
  syncId: "0123456789abcdef0123456789abcdef",
  sessionId,
  revision: 7
};

describe("acknowledged renderer acquisition", () => {
  it("selects one exact session and renderer generation", async () => {
    const locator = { count: vi.fn(async () => 1) };
    const frame = { locator: vi.fn(() => locator) };

    await expect(exactSessionApp(frame, sessionId, receipt.syncId)).resolves.toBe(locator);
    expect(frame.locator).toHaveBeenCalledWith(
      `main.app[data-session-id="${sessionId}"][data-renderer-sync-id="${receipt.syncId}"]`
    );
  });

  it("does not accept an absent or ambiguous renderer", async () => {
    for (const count of [0, 2]) {
      const locator = { count: vi.fn(async () => count) };
      await expect(exactSessionApp({ locator: () => locator }, sessionId)).resolves.toBeUndefined();
    }
  });

  it("rejects invalid selector identities before probing the frame", async () => {
    const frame = { locator: vi.fn(() => ({ count: vi.fn(async () => 1) })) };
    await expect(exactSessionApp(frame, "not-a-session")).rejects.toThrow();
    await expect(exactSessionApp(frame, sessionId, "not-a-sync-id")).rejects.toThrow();
    expect(frame.locator).not.toHaveBeenCalled();
  });

  it("compares the complete synchronization receipt", () => {
    expect(sameRendererSynchronizationReceipt(receipt, { ...receipt })).toBe(true);
    expect(sameRendererSynchronizationReceipt(receipt, { ...receipt, revision: 8 })).toBe(false);
    expect(sameRendererSynchronizationReceipt(receipt, { ...receipt, sessionId: `${sessionId}-other` })).toBe(false);
    expect(sameRendererSynchronizationReceipt(receipt, { ...receipt, syncId: "f".repeat(32) })).toBe(false);
    expect(sameRendererSynchronizationReceipt(receipt, undefined)).toBe(false);
  });

  it("reacquires only the retained hydrated receipt without synchronizing", async () => {
    const target = { id: "renderer-a" };
    const locator = { id: "app-a" };
    const testing: AcknowledgedRendererApi = {
      panelHydrated: vi.fn(() => true),
      panelSynchronizationReceipt: vi.fn(() => receipt)
    };
    const findTarget = vi.fn(async () => target);
    const appForTarget = vi.fn(async () => locator);

    await expect(
      reacquireAcknowledgedSessionApp(testing, sessionId, "Profile", findTarget, appForTarget)
    ).resolves.toBe(locator);
    expect(findTarget).toHaveBeenCalledWith(receipt);
    expect(appForTarget).toHaveBeenCalledWith(target, receipt.syncId);
    expect(testing.panelSynchronizationReceipt).toHaveBeenCalledTimes(2);
  });

  it("fails closed when hydration or receipt identity changes during acquisition", async () => {
    const receipts: Array<RendererSynchronizationReceipt | undefined> = [receipt, { ...receipt, revision: 8 }];
    const testing: AcknowledgedRendererApi = {
      panelHydrated: vi.fn(() => true),
      panelSynchronizationReceipt: vi.fn(() => receipts.shift())
    };
    await expect(
      reacquireAcknowledgedSessionApp(
        testing,
        sessionId,
        "Profile",
        async () => ({ id: "renderer-a" }),
        async () => ({ id: "app-a" })
      )
    ).rejects.toThrow(/receipt must remain unchanged/u);

    testing.panelSynchronizationReceipt = vi.fn(() => receipt);
    testing.panelHydrated = vi.fn(() => false);
    await expect(
      reacquireAcknowledgedSessionApp(
        testing,
        sessionId,
        "Profile",
        async () => ({ id: "renderer-a" }),
        async () => ({ id: "app-a" })
      )
    ).rejects.toThrow(/must remain hydrated/u);
  });
});
