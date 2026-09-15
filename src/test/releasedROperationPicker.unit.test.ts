import type { Frame, Locator, Page } from "playwright-core";
import { expect, it, vi } from "vitest";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { bindReleasedROperationDialog, createReleasedROperationPicker } from "./extensionHost/releasedROperationPicker";

const sessionId = "11111111-1111-4111-8111-111111111111";

it("bounds dialog acquisition while retaining cleanup of a late handle", async () => {
  vi.useFakeTimers({ now: 0 });
  const receipt = { sessionId, revision: 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    panelHydrated: () => true,
    panelSynchronizationReceipt: () => receipt
  } as unknown as TestApi;
  let releaseElement!: () => void;
  const elementReady = new Promise<void>((resolve) => {
    releaseElement = resolve;
  });
  let releaseDisposal!: () => void;
  const disposalReady = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  let disposed = false;
  const element = {
    ownerFrame: vi.fn(),
    evaluate: vi.fn(),
    dispose: vi.fn(async () => {
      await disposalReady;
      disposed = true;
    })
  };
  const dialog = {
    elementHandle: async () => {
      await elementReady;
      return element;
    }
  } as unknown as Locator;
  let settled = false;
  let failure: unknown;
  const pending = bindReleasedROperationDialog(testing, dialog, sessionId, 1_000).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      failure = error;
    }
  );
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(true);
    expect(String(failure)).toContain("Timed out waiting for the native R dialog acquisition after 1000 ms.");
    releaseElement();
    await vi.advanceTimersByTimeAsync(0);
    expect(element.dispose).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(false);
    expect(element.ownerFrame).not.toHaveBeenCalled();
    expect(element.evaluate).not.toHaveBeenCalled();
    releaseDisposal();
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toBe(true);
    expect(element.dispose).toHaveBeenCalledTimes(1);
  } finally {
    try {
      releaseElement();
      releaseDisposal();
      await vi.advanceTimersByTimeAsync(0);
      await pending;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }
});

it("retains the primary dialog acquisition error and its cleanup failure", async () => {
  const receipt = { sessionId, revision: 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    panelHydrated: () => true,
    panelSynchronizationReceipt: () => receipt
  } as unknown as TestApi;
  const failure = new Error("The acquired dialog frame is unavailable.");
  const cleanupFailure = new Error("The handle disposal also failed.");
  const element = {
    ownerFrame: async () => {
      throw failure;
    },
    dispose: vi.fn(async () => {
      throw cleanupFailure;
    })
  };
  const dialog = { elementHandle: async () => element } as unknown as Locator;
  const result = await bindReleasedROperationDialog(testing, dialog, sessionId).catch((error: unknown) => error);
  expect(result).toBeInstanceOf(AggregateError);
  if (!(result instanceof AggregateError)) throw new Error("Expected both acquisition and cleanup failures.");
  expect(result.errors).toHaveLength(2);
  expect(result.errors[0]).toBe(failure);
  expect(result.errors[1]).toBe(cleanupFailure);
  expect(element.dispose).toHaveBeenCalledTimes(1);
});

it.each([false, true])("does not acquire a late renderer after the picker deadline (retry=%s)", async (retry) => {
  vi.useFakeTimers({ now: 0 });
  let published = false;
  const receipt = { sessionId, revision: 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  const synchronizePanel = vi.fn();
  const ensurePanelSynchronized = vi.fn();
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    synchronizePanel,
    ensurePanelSynchronized,
    panelHydrated: () => published,
    panelSynchronizationReceipt: () => (published ? receipt : undefined)
  } as unknown as TestApi;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const observations: Promise<void>[] = [];
  let first = true;
  const observe = vi.fn((predicate: () => boolean, timeoutMs: number) => {
    const pending = (async () => {
      if (retry && first) {
        first = false;
        await wait(4_000);
        throw new Error("The initial renderer was retired.");
      }
      await wait(timeoutMs);
      if (!predicate()) throw new Error("The renderer was not published before its deadline.");
    })();
    observations.push(
      pending.then(
        () => undefined,
        () => undefined
      )
    );
    return pending;
  });
  const findTarget = vi.fn(async () => {
    throw new Error("A late renderer must not start browser acquisition.");
  });
  const picker = createReleasedROperationPicker({
    waitFor: observe,
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
    expect(observe).toHaveBeenCalledTimes(retry ? 2 : 1);
    await vi.advanceTimersByTimeAsync(1_000);
    published = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(observations);
    expect(findTarget).not.toHaveBeenCalled();
    expect(synchronizePanel).not.toHaveBeenCalled();
    expect(ensurePanelSynchronized).not.toHaveBeenCalled();
  } finally {
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([...observations, pendingPicker]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  }
});

it("keeps the direct acquisition budget and binds the naturally published receipt", async () => {
  vi.useFakeTimers({ now: 0 });
  let publish!: () => void;
  const publication = new Promise<void>((resolve) => {
    publish = resolve;
  });
  const receipt = { sessionId, revision: 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  let hydrated = false;
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    panelHydrated: () => hydrated,
    panelSynchronizationReceipt: () => (hydrated ? receipt : undefined)
  } as unknown as TestApi;
  const app = { count: async () => 1 } as Locator;
  const frame = { locator: vi.fn(() => app) } as unknown as Frame;
  const picker = createReleasedROperationPicker({
    waitFor: async (predicate, timeoutMs) => {
      expect(timeoutMs).toBe(30_000);
      await publication;
      expect(predicate()).toBe(true);
    },
    waitForOpenWranglerGridTarget: async () => ({ frame })
  });
  const pending = picker.synchronizedSessionApp({} as Page, testing, sessionId, "The direct session must arrive.");
  const settled = pending.then(
    () => undefined,
    () => undefined
  );
  try {
    await vi.advanceTimersByTimeAsync(11_000);
    hydrated = true;
    publish();
    expect(await pending).toBe(app);
    expect(frame.locator).toHaveBeenCalledExactlyOnceWith(
      `main.app[data-session-id="${sessionId}"][data-renderer-sync-id="${receipt.syncId}"]`
    );
  } finally {
    publish();
    await settled;
    vi.useRealTimers();
  }
});

it.each([false, true])("observes the original session publication without repair (stale=%s)", async (stale) => {
  let receipt = { sessionId, revision: stale ? 6 : 7, syncId: "a".repeat(32), layoutTransitionPending: false };
  const synchronizePanel = vi.fn(async () => {
    receipt = { ...receipt, revision: 7 };
    return true;
  });
  const ensurePanelSynchronized = vi.fn(async () => true);
  const testing = {
    activeSession: () => ({ sessionId, metadata: { revision: 7 } }),
    synchronizePanel,
    ensurePanelSynchronized,
    panelHydrated: () => true,
    panelSynchronizable: () => true,
    panelSynchronizationReceipt: () => receipt
  } as unknown as TestApi;
  const app = { count: async () => 1 } as Locator;
  const frame = { locator: () => app } as unknown as Frame;
  const dependencies = {
    waitFor: async (predicate: () => boolean) => {
      if (!predicate()) throw new Error("The original renderer revision did not arrive.");
    },
    waitForOpenWranglerGridTarget: async () => ({ frame })
  };
  const picker = createReleasedROperationPicker(dependencies);
  const result = picker.releasedRSessionApp({} as Page, testing, sessionId, "The visible mutation result");
  if (stale) await expect(result).rejects.toThrow("The original renderer revision did not arrive.");
  else await expect(result).resolves.toBe(app);
  expect(synchronizePanel).not.toHaveBeenCalled();
  expect(ensurePanelSynchronized).not.toHaveBeenCalled();
});
