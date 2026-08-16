import type { Locator } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import {
  backendSwitchPhysicalViewMatches,
  sampleBackendSwitchPhysicalView,
  verifyBackendSwitchPhysicalView,
  type BackendSwitchPhysicalViewOptions,
  type BackendSwitchPhysicalViewRoot,
  type BackendSwitchPhysicalViewSample
} from "./extensionHost/backendSwitchPhysicalView";
import type { RendererSynchronizationReceipt } from "./extensionHost/acknowledgedRenderer";

const receipt = (syncId: string, revision = 7): RendererSynchronizationReceipt => ({
  syncId,
  sessionId: "session",
  revision
});

const matchingSample = (syncId = "sync-a"): BackendSwitchPhysicalViewSample => ({
  backendLabel: "Change dataframe engine. Current engine: Pandas",
  backendWidth: 96,
  connected: true,
  headerSelected: "true",
  headerWidth: 287,
  rowHeight: 20,
  rowPresent: true,
  scrollLeft: 113,
  scrollTop: 740,
  syncId
});

function fakeElement(
  attributes: Record<string, string>,
  box: Partial<Readonly<{ width: number; height: number }>> = {}
): NonNullable<ReturnType<BackendSwitchPhysicalViewRoot["querySelector"]>> {
  return {
    scrollLeft: 0,
    scrollTop: 0,
    closest: () => null,
    getAttribute: (name: string) => attributes[name] ?? null,
    getBoundingClientRect: () => ({ width: 0, height: 0, ...box })
  };
}

describe("backend-switch physical grid", () => {
  it("samples the exact backend, market header, row 37, scroller, and renderer receipt", () => {
    const selectors: string[] = [];
    const row = fakeElement({}, { height: 20 });
    const cell = {
      scrollLeft: 0,
      scrollTop: 0,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ width: 0, height: 0 }),
      closest: (selector: string) => (selector === "tr" ? row : null)
    };
    const elements = new Map<string, NonNullable<ReturnType<BackendSwitchPhysicalViewRoot["querySelector"]>>>([
      ['[data-session-badge="backend"]', fakeElement({ "aria-label": "backend" }, { width: 96 })],
      ['th[data-column="market"]', fakeElement({ "aria-selected": "true" }, { width: 287 })],
      ['td[data-grid-row="37"][data-grid-column="1"]', cell],
      [
        '[data-testid="data-grid-scroller"]',
        {
          scrollLeft: 113,
          scrollTop: 740,
          getAttribute: () => null,
          getBoundingClientRect: () => ({ width: 0, height: 0 }),
          closest: () => null
        }
      ]
    ]);
    const root = {
      isConnected: true,
      getAttribute: (name: string) => (name === "data-renderer-sync-id" ? "sync-a" : null),
      querySelector: (selector: string) => {
        selectors.push(selector);
        return elements.get(selector) ?? null;
      }
    } as unknown as BackendSwitchPhysicalViewRoot;

    expect(sampleBackendSwitchPhysicalView(root)).toEqual({
      backendLabel: "backend",
      backendWidth: 96,
      connected: true,
      headerSelected: "true",
      headerWidth: 287,
      rowHeight: 20,
      rowPresent: true,
      scrollLeft: 113,
      scrollTop: 740,
      syncId: "sync-a"
    });
    expect(selectors).toEqual([
      '[data-session-badge="backend"]',
      'th[data-column="market"]',
      'td[data-grid-row="37"][data-grid-column="1"]',
      '[data-testid="data-grid-scroller"]'
    ]);
  });

  it("requires the exact backend, receipt, selected width, and restored viewport", () => {
    expect(backendSwitchPhysicalViewMatches(matchingSample(), "sync-a", "Pandas")).toBe(true);
    for (const changed of [
      { backendLabel: "Change dataframe engine. Current engine: Polars" },
      { backendWidth: 0 },
      { connected: false },
      { syncId: "sync-b" },
      { headerSelected: "false" },
      { headerWidth: 289 },
      { rowPresent: false },
      { rowHeight: 0 },
      { scrollLeft: 115 },
      { scrollTop: 744 }
    ]) {
      expect(backendSwitchPhysicalViewMatches({ ...matchingSample(), ...changed }, "sync-a", "Pandas")).toBe(false);
    }
  });

  function options(
    overrides: Partial<BackendSwitchPhysicalViewOptions<string>> = {}
  ): BackendSwitchPhysicalViewOptions<string> {
    let now = 0;
    const current = receipt("sync-a");
    const app = {
      evaluate: async () => matchingSample()
    } as unknown as Locator;
    return {
      sessionId: "session",
      backend: "Pandas",
      expectedRevision: 7,
      discoveryTimeoutMs: 100,
      activeSession: () => ({ sessionId: "session", metadata: { revision: 7 } }),
      currentReceipt: () => current,
      panelHydrated: () => true,
      requireHydration: async () => {},
      assertLifecycle: () => {},
      findCurrentTarget: async () => "target",
      bindExactApp: async () => app,
      targetIsRetired: () => false,
      withDeadline: async (promise) => Promise.resolve(promise),
      now: () => now,
      wait: async (durationMs) => {
        now += durationMs;
      },
      ...overrides
    };
  }

  it("hydrates, binds one current receipt, and samples its exact app", async () => {
    const requireHydration = vi.fn(async () => {});
    const findCurrentTarget = vi.fn(async () => "target");
    const bindExactApp = vi.fn(async () => ({ evaluate: async () => matchingSample() }) as unknown as Locator);
    const deadlines: Array<Readonly<{ timeoutMs: number; description: string }>> = [];
    const withDeadline = async <T>(promise: PromiseLike<T>, timeoutMs: number, description: string): Promise<T> => {
      deadlines.push({ timeoutMs, description });
      return Promise.resolve(promise);
    };

    await verifyBackendSwitchPhysicalView(options({ requireHydration, findCurrentTarget, bindExactApp, withDeadline }));

    expect(requireHydration).toHaveBeenCalledWith(
      "The Pandas renderer must acknowledge the switched file session before its physical view is checked.",
      100
    );
    expect(findCurrentTarget).toHaveBeenCalledWith(receipt("sync-a"), 100);
    expect(bindExactApp).toHaveBeenCalledWith("target", "sync-a");
    expect(deadlines).toEqual([{ timeoutMs: 75, description: "the Pandas receipt-bound physical grid sample" }]);
  });

  it("discards a receipt superseded during discovery before binding the replacement", async () => {
    let current = receipt("sync-a");
    const findCurrentTarget = vi.fn(async (observed: RendererSynchronizationReceipt) => {
      if (observed.syncId === "sync-a") current = receipt("sync-b");
      return observed.syncId;
    });
    const bindExactApp = vi.fn(async (_target: string, syncId: string) => {
      return { evaluate: async () => matchingSample(syncId) } as unknown as Locator;
    });

    await verifyBackendSwitchPhysicalView(options({ currentReceipt: () => current, findCurrentTarget, bindExactApp }));

    expect(findCurrentTarget.mock.calls.map(([observed]) => observed.syncId)).toEqual(["sync-a", "sync-b"]);
    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(bindExactApp).toHaveBeenCalledWith("sync-b", "sync-b");
  });

  it("never samples a target retired during binding and succeeds on the replacement receipt", async () => {
    let current = receipt("sync-a");
    const retired = new Set<string>();
    const sampleA = vi.fn(async () => matchingSample("sync-a"));
    const sampleB = vi.fn(async () => matchingSample("sync-b"));
    const findCurrentTarget = vi.fn(async (observed: RendererSynchronizationReceipt) => `target-${observed.syncId}`);
    const bindExactApp = vi.fn(async (target: string) => {
      if (target === "target-sync-a") {
        retired.add(target);
        current = receipt("sync-b");
        return { evaluate: sampleA } as unknown as Locator;
      }
      return { evaluate: sampleB } as unknown as Locator;
    });

    await verifyBackendSwitchPhysicalView(
      options({
        currentReceipt: () => current,
        findCurrentTarget,
        bindExactApp,
        targetIsRetired: (target) => retired.has(target)
      })
    );

    expect(findCurrentTarget.mock.calls.map(([observed]) => observed.syncId)).toEqual(["sync-a", "sync-b"]);
    expect(bindExactApp.mock.calls.map(([target]) => target)).toEqual(["target-sync-a", "target-sync-b"]);
    expect(sampleA).not.toHaveBeenCalled();
    expect(sampleB).toHaveBeenCalledOnce();
  });

  it("discards a sample when its bound target retires during evaluate and reacquires", async () => {
    let current = receipt("sync-a");
    const retired = new Set<string>();
    const sampleA = vi.fn(async () => {
      retired.add("target-sync-a");
      current = receipt("sync-b");
      return matchingSample("sync-a");
    });
    const sampleB = vi.fn(async () => matchingSample("sync-b"));
    const findCurrentTarget = vi.fn(async (observed: RendererSynchronizationReceipt) => `target-${observed.syncId}`);
    const bindExactApp = vi.fn(async (target: string) => {
      return { evaluate: target === "target-sync-a" ? sampleA : sampleB } as unknown as Locator;
    });

    await verifyBackendSwitchPhysicalView(
      options({
        currentReceipt: () => current,
        findCurrentTarget,
        bindExactApp,
        targetIsRetired: (target) => retired.has(target)
      })
    );

    expect(sampleA).toHaveBeenCalledOnce();
    expect(sampleB).toHaveBeenCalledOnce();
    expect(findCurrentTarget.mock.calls.map(([observed]) => observed.syncId)).toEqual(["sync-a", "sync-b"]);
  });

  it("does not sample a target retired during binding while its receipt remains current", async () => {
    let now = 0;
    let retired = false;
    const evaluate = vi.fn(async () => matchingSample("sync-a"));
    const bindExactApp = vi.fn(async () => {
      retired = true;
      return { evaluate } as unknown as Locator;
    });

    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          discoveryTimeoutMs: 50,
          bindExactApp,
          targetIsRetired: () => retired,
          now: () => now,
          wait: async (durationMs) => {
            now += durationMs;
          }
        })
      )
    ).rejects.toThrow(/exceeded its shared renderer deadline/u);

    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("does not accept a matching sample when its current target retires during evaluate", async () => {
    let now = 0;
    let retired = false;
    const evaluate = vi.fn(async () => {
      retired = true;
      return matchingSample("sync-a");
    });

    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          discoveryTimeoutMs: 50,
          bindExactApp: async () => ({ evaluate }) as unknown as Locator,
          targetIsRetired: () => retired,
          now: () => now,
          wait: async (durationMs) => {
            now += durationMs;
          }
        })
      )
    ).rejects.toThrow(/exceeded its shared renderer deadline/u);

    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("rejects an exact-session drift caused during physical sampling", async () => {
    let activeSessionId = "session";
    const evaluate = vi.fn(async () => {
      activeSessionId = "replacement";
      return matchingSample("sync-a");
    });

    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          activeSession: () => ({ sessionId: activeSessionId, metadata: { revision: 7 } }),
          bindExactApp: async () => ({ evaluate }) as unknown as Locator
        })
      )
    ).rejects.toThrow("The exact session must remain active.");

    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("rejects a revision drift caused during physical sampling", async () => {
    let activeRevision = 7;
    const evaluate = vi.fn(async () => {
      activeRevision = 8;
      return matchingSample("sync-a");
    });

    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          activeSession: () => ({ sessionId: "session", metadata: { revision: activeRevision } }),
          bindExactApp: async () => ({ evaluate }) as unknown as Locator
        })
      )
    ).rejects.toThrow("The switched revision must remain unchanged through physical verification.");

    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("reruns the lifecycle proof after physical sampling", async () => {
    let lifecycleValid = true;
    const assertLifecycle = vi.fn(() => {
      if (!lifecycleValid) throw new Error("renderer lifecycle drifted during sampling");
    });
    const evaluate = vi.fn(async () => {
      lifecycleValid = false;
      return matchingSample("sync-a");
    });

    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          assertLifecycle,
          bindExactApp: async () => ({ evaluate }) as unknown as Locator
        })
      )
    ).rejects.toThrow("renderer lifecycle drifted during sampling");

    expect(evaluate).toHaveBeenCalledOnce();
    expect(assertLifecycle).toHaveBeenCalledTimes(3);
  });

  it("fails immediately when the exact switched session drifts", async () => {
    const findCurrentTarget = vi.fn(async () => "target");
    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          activeSession: () => ({ sessionId: "replacement", metadata: { revision: 7 } }),
          findCurrentTarget
        })
      )
    ).rejects.toThrow("The exact session must remain active.");
    expect(findCurrentTarget).not.toHaveBeenCalled();
  });

  it("fails immediately when the switched revision drifts", async () => {
    const findCurrentTarget = vi.fn(async () => "target");
    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          activeSession: () => ({ sessionId: "session", metadata: { revision: 8 } }),
          findCurrentTarget
        })
      )
    ).rejects.toThrow("The switched revision must remain unchanged through physical verification.");
    expect(findCurrentTarget).not.toHaveBeenCalled();
  });

  it("reports the last sample and superseded receipts at the shared deadline", async () => {
    let now = 0;
    const nonmatching = { ...matchingSample(), scrollLeft: 0 };
    await expect(
      verifyBackendSwitchPhysicalView(
        options({
          discoveryTimeoutMs: 50,
          bindExactApp: async () => ({ evaluate: async () => nonmatching }) as unknown as Locator,
          now: () => now,
          wait: async (durationMs) => {
            now += durationMs;
          }
        })
      )
    ).rejects.toThrow(/exceeded its shared renderer deadline.*"scrollLeft":0/u);
  });
});
