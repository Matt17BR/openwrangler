import type { Frame, Locator, Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { requireFreshExactSessionPanelHydration } from "./extensionHost/panelHydration";
import { createReleasedROperationPicker } from "./extensionHost/releasedROperationPicker";

const sessionId = "11111111-1111-4111-8111-111111111111";

it.each([false, true])("does not start hydration repair after the picker deadline (retry=%s)", async (retry) => {
  vi.useFakeTimers({ now: 0 });
  let finishSynchronization!: (value: boolean) => void;
  let finishEnsure!: (value: boolean) => void;
  const synchronization = new Promise<boolean>((resolve) => {
    finishSynchronization = resolve;
  });
  const ensure = new Promise<boolean>((resolve) => {
    finishEnsure = resolve;
  });
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const synchronizePanel = vi.fn(async () => synchronization);
  if (retry)
    synchronizePanel.mockImplementationOnce(async () => {
      await wait(4_000);
      throw new Error("The initial renderer could not be synchronized.");
    });
  const ensurePanelSynchronized = vi.fn(async () => ensure);
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    synchronizePanel,
    ensurePanelSynchronized,
    panelHydrated: () => false,
    panelSynchronizable: () => true,
    panelSynchronizationReceipt: () => undefined
  } as unknown as TestApi;
  const hydrations: Promise<void>[] = [];
  // Match the installed harness adapter's default; execute the real hydration owner.
  const hydrate = (api: TestApi, id: string, expectation: string, timeoutMs = 30_000) => {
    const pending = requireFreshExactSessionPanelHydration(api, id, expectation, { timeoutMs });
    hydrations.push(
      pending.then(
        () => undefined,
        () => undefined
      )
    );
    return pending;
  };
  const waitFor = vi.fn(async () => {
    throw new Error("Hydration must precede layout acquisition.");
  });
  const findTarget = vi.fn(async () => {
    throw new Error("Hydration must precede browser acquisition.");
  });
  const picker = createReleasedROperationPicker({
    requireFreshExactSessionPanelHydration: hydrate,
    waitFor,
    waitForOpenWranglerGridTarget: findTarget
  });
  const pendingPicker = picker.openReleasedROperationPicker(testing, { waitForTimeout: wait } as Page, sessionId).then(
    () => ({ at: Date.now(), error: undefined }),
    (error: unknown) => ({ at: Date.now(), error })
  );
  try {
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pendingPicker;
    expect(outcome.at).toBe(10_000);
    expect(outcome.error).toBeInstanceOf(Error);
    expect(String(outcome.error)).toContain("did not become actionable");
    expect(synchronizePanel).toHaveBeenCalledTimes(retry ? 2 : 1);
    expect(ensurePanelSynchronized).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    finishSynchronization(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(ensurePanelSynchronized).not.toHaveBeenCalled();
    expect(waitFor).not.toHaveBeenCalled();
    expect(findTarget).not.toHaveBeenCalled();
  } finally {
    try {
      finishSynchronization(false);
      finishEnsure(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([...hydrations, pendingPicker]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }
});

it("keeps the default hydration budget for a direct session acquisition", async () => {
  vi.useFakeTimers({ now: 0 });
  let finishSynchronization!: (value: boolean) => void;
  const synchronization = new Promise<boolean>((resolve) => {
    finishSynchronization = resolve;
  });
  const receipt = { sessionId, revision: 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  let hydrated = false;
  const ensurePanelSynchronized = vi.fn(async () => {
    hydrated = true;
    return true;
  });
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    synchronizePanel: async () => synchronization,
    ensurePanelSynchronized,
    panelHydrated: () => hydrated,
    panelSynchronizable: () => true,
    panelSynchronizationReceipt: () => (hydrated ? receipt : undefined)
  } as unknown as TestApi;
  const hydrate = vi.fn((api: TestApi, id: string, expectation: string, timeoutMs = 30_000) =>
    requireFreshExactSessionPanelHydration(api, id, expectation, { timeoutMs })
  );
  const app = { count: async () => 1 } as Locator;
  const frame = { locator: vi.fn(() => app) } as unknown as Frame;
  const picker = createReleasedROperationPicker({
    requireFreshExactSessionPanelHydration: hydrate,
    waitFor: async (predicate) => {
      expect(predicate()).toBe(true);
    },
    waitForOpenWranglerGridTarget: async () => ({ frame })
  });
  const pending = picker.synchronizedSessionApp({} as Page, testing, sessionId, "The direct session must hydrate.");
  const settled = pending.then(
    () => undefined,
    () => undefined
  );
  try {
    await vi.advanceTimersByTimeAsync(11_000);
    expect(ensurePanelSynchronized).not.toHaveBeenCalled();
    finishSynchronization(false);
    expect(await pending).toBe(app);
    expect(hydrate.mock.calls[0]?.[3]).toBeUndefined();
    expect(ensurePanelSynchronized).toHaveBeenCalledExactlyOnceWith(sessionId, 30_000);
    expect(frame.locator).toHaveBeenCalledExactlyOnceWith(
      `main.app[data-session-id="${sessionId}"][data-renderer-sync-id="${receipt.syncId}"]`
    );
  } finally {
    try {
      finishSynchronization(false);
      await vi.advanceTimersByTimeAsync(30_000);
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }
});
