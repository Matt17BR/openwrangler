import type { Locator } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { AcceptanceActionNotDispatchedError } from "./extensionHost/playwrightLifecycle";
import {
  findRecoveredExcelGridActivationTarget,
  measureRecoveredExcelNeighborExposure,
  verifyRecoveredExcelGrid,
  type RecoveredExcelGridOptions
} from "./extensionHost/recoveredExcelGrid";
import type { RendererSynchronizationReceipt } from "./extensionHost/acknowledgedRenderer";

interface FakeRect {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

const rect = (left: number, top: number, width: number, height: number): FakeRect => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height
});

interface GridGeometryOptions {
  readonly hitTested?: boolean;
  readonly neighborFocused?: boolean;
  readonly neighborRect?: FakeRect;
}

function gridGeometry({
  hitTested = true,
  neighborFocused = true,
  neighborRect = rect(180, 60, 80, 20)
}: GridGeometryOptions = {}): Readonly<{ grid: unknown; cell: unknown; neighbor: unknown }> {
  const documentState: { activeElement?: unknown; hit?: unknown } = {};
  const ownerDocument: {
    activeElement?: unknown;
    elementFromPoint: () => unknown;
    hasFocus: () => boolean;
  } = {
    activeElement: undefined,
    elementFromPoint: () => documentState.hit,
    hasFocus: () => true
  };
  const headers = [{ getBoundingClientRect: () => rect(0, 0, 500, 30) }];
  const rowHeaders = [{ getBoundingClientRect: () => rect(0, 0, 50, 30) }];
  const scroller = {
    clientHeight: 270,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 450,
    getBoundingClientRect: () => rect(50, 30, 450, 270)
  };
  const grid = {
    closest: (selector: string) => (selector === ".tableScroller" ? scroller : null),
    querySelectorAll: (selector: string) => {
      if (selector === "thead th") return headers;
      if (selector === "thead th.rowHeader") return rowHeaders;
      if (selector === "tbody td.gridCell[data-grid-row][data-grid-column]") return [cell];
      return [];
    }
  };
  const cell = {
    dataset: { gridRow: "4", gridColumn: "3" },
    ownerDocument,
    isConnected: true,
    contains: () => false,
    closest: (selector: string) =>
      selector === '[role="grid"]' ? grid : selector === ".tableScroller" ? scroller : null,
    getBoundingClientRect: () => rect(100, 60, 80, 20)
  };
  const neighbor = {
    ...cell,
    dataset: { gridRow: "4", gridColumn: "4" },
    getBoundingClientRect: () => neighborRect
  };
  documentState.hit = hitTested ? cell : {};
  ownerDocument.activeElement = neighborFocused ? neighbor : undefined;
  return { grid, cell, neighbor };
}

const receipt: RendererSynchronizationReceipt = { syncId: "sync-a", sessionId: "session", revision: 7 };

interface FakeAppOptions {
  readonly activationDispose?: () => Promise<void>;
  readonly activationEvaluate?: () => Promise<{
    readonly connected: boolean;
    readonly documentFocused: boolean;
    readonly cellFocused: boolean;
  }>;
}

function fakeApp({
  activationDispose = vi.fn(async () => {}),
  activationEvaluate = async () => ({ connected: true, documentFocused: true, cellFocused: true })
}: FakeAppOptions = {}): Locator {
  const activationHandle = {
    evaluate: activationEvaluate,
    dispose: activationDispose
  };
  const grid = {
    waitFor: vi.fn(async () => {}),
    getAttribute: vi.fn(async (name: string) => (name === "aria-colcount" ? "7" : "65")),
    evaluate: vi.fn(async () => ({
      diagnostics: {
        candidateCount: 1,
        exposedBounds: { left: 50, top: 30, right: 500, bottom: 300 },
        dataColumnCount: 6,
        fullyExposedCellCount: 1,
        pointerExposedCellCount: 1,
        scrollerFound: true
      },
      target: { row: 4, column: 3 }
    }))
  };
  const firstCell = {
    first: () => firstCell,
    waitFor: vi.fn(async () => {}),
    innerText: vi.fn(async () => " OW-240001 ")
  };
  const activationCell = {
    first: () => activationCell,
    elementHandle: vi.fn(async () => activationHandle)
  };
  const neighbor = {
    first: () => neighbor,
    waitFor: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      connected: true,
      focused: true,
      fullyExposed: true,
      cellRect: { bottom: 80, left: 180, right: 260, top: 60 },
      exposedBounds: { left: 50, top: 30, right: 500, bottom: 300 }
    }))
  };
  return {
    getByRole: () => grid,
    locator: (selector: string) => {
      if (selector.includes(":focus")) return neighbor;
      if (selector.includes('data-grid-row="4"')) return activationCell;
      return firstCell;
    }
  } as unknown as Locator;
}

describe("recovered XLSX grid", () => {
  it("chooses a fully exposed hit-tested cell that retains a right-hand neighbor", () => {
    const { grid } = gridGeometry();
    const probe = findRecoveredExcelGridActivationTarget(grid, 6);
    expect(probe.target).toEqual({ row: 4, column: 3 });
    expect(probe.diagnostics).toMatchObject({
      candidateCount: 1,
      fullyExposedCellCount: 1,
      pointerExposedCellCount: 1,
      scrollerFound: true
    });
  });

  it("rejects grids without a scroller and cells without a neighbor", () => {
    expect(
      findRecoveredExcelGridActivationTarget({ closest: () => null, querySelectorAll: () => [] }, 6)
    ).toMatchObject({ target: undefined, diagnostics: { scrollerFound: false } });
    const { grid } = gridGeometry();
    expect(findRecoveredExcelGridActivationTarget(grid, 4).target).toBeUndefined();
  });

  it("rejects a fully exposed cell when its center is occluded", () => {
    const { grid } = gridGeometry({ hitTested: false });
    expect(findRecoveredExcelGridActivationTarget(grid, 6)).toMatchObject({
      target: undefined,
      diagnostics: { fullyExposedCellCount: 1, pointerExposedCellCount: 0 }
    });
  });

  it("measures neighbor focus inside the data viewport below sticky headers", () => {
    const { neighbor } = gridGeometry();
    expect(measureRecoveredExcelNeighborExposure(neighbor)).toMatchObject({
      connected: true,
      focused: true,
      fullyExposed: true,
      exposedBounds: { left: 50, top: 30, right: 500, bottom: 300 }
    });
  });

  it("rejects an unfocused neighbor outside the exposed data viewport", () => {
    const { neighbor } = gridGeometry({
      neighborFocused: false,
      neighborRect: rect(470, 290, 80, 20)
    });
    expect(measureRecoveredExcelNeighborExposure(neighbor)).toMatchObject({
      connected: true,
      focused: false,
      fullyExposed: false,
      exposedBounds: { left: 50, top: 30, right: 500, bottom: 300 }
    });
  });

  function options(overrides: Partial<RecoveredExcelGridOptions<string>> = {}): RecoveredExcelGridOptions<string> {
    let now = 0;
    return {
      sessionId: "session",
      revision: 7,
      sourceLabel: "orders.xlsx",
      discoveryTimeoutMs: 30_000,
      operationTimeoutMs: 10_000,
      activeSession: () => ({ sessionId: "session", metadata: { revision: 7 } }),
      currentReceipt: () => receipt,
      panelHydrated: () => true,
      panelSynchronizable: () => true,
      activeTabDiagnostic: () => ({ label: "orders.xlsx" }),
      findCurrentTarget: async () => "target",
      bindExactApp: async () => fakeApp(),
      targetIsRetired: () => false,
      assertTargetLifecycle: () => {},
      ignoreRetiredProbeFailure: (_target, error) => {
        throw error;
      },
      pressTargetKey: async () => {},
      recordProgress: () => {},
      withDeadline: async <T>(promise: PromiseLike<T>) => Promise.resolve(promise),
      activateElementOnce: async (_element, _timeoutMs, beforeDispatch) => beforeDispatch(),
      now: () => now,
      wait: async (durationMs) => {
        now += durationMs;
      },
      ...overrides
    };
  }

  it("binds one acknowledged renderer and crosses the trusted click only once", async () => {
    const progress: string[] = [];
    const pressTargetKey = vi.fn(async () => {});
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      beforeDispatch();
    });

    await verifyRecoveredExcelGrid(
      options({ recordProgress: (checkpoint) => progress.push(checkpoint), pressTargetKey, activateElementOnce })
    );

    expect(progress).toEqual([
      "excel-dependency-install:grid-bound",
      "excel-dependency-install:grid-activation-target",
      "excel-dependency-install:grid-activation-dispatched",
      "excel-dependency-install:grid-focused",
      "excel-dependency-install:grid-arrow-sent",
      "excel-dependency-install:grid-keyboard"
    ]);
    expect(activateElementOnce).toHaveBeenCalledOnce();
    expect(pressTargetKey).toHaveBeenCalledWith("target", "ArrowRight");
  });

  it("retries a proven pre-dispatch failure but never a failure after the click boundary", async () => {
    let attempts = 0;
    const findCurrentTarget = vi.fn(async () => "target");
    await verifyRecoveredExcelGrid(
      options({
        findCurrentTarget,
        activateElementOnce: async (_element, _timeoutMs, beforeDispatch) => {
          attempts += 1;
          if (attempts === 1) {
            throw new AcceptanceActionNotDispatchedError("activation", new Error("replaced"));
          }
          beforeDispatch();
        }
      })
    );
    expect(attempts).toBe(2);
    expect(findCurrentTarget).toHaveBeenCalledTimes(2);

    const postBoundaryTarget = vi.fn(async () => "target");
    await expect(
      verifyRecoveredExcelGrid(
        options({
          findCurrentTarget: postBoundaryTarget,
          activateElementOnce: async (_element, _timeoutMs, beforeDispatch) => {
            beforeDispatch();
            throw new Error("click indeterminate");
          }
        })
      )
    ).rejects.toThrow("click indeterminate");
    expect(postBoundaryTarget).toHaveBeenCalledOnce();
  });

  it("reacquires when the receipt changes before dispatch without crossing the stale click", async () => {
    let currentReceipt = receipt;
    let activationAttempts = 0;
    let staleClicks = 0;
    let currentClicks = 0;
    const findCurrentTarget = vi.fn(async (observed: RendererSynchronizationReceipt) => `target-${observed.syncId}`);
    const bindExactApp = vi.fn(async () => fakeApp());
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      activationAttempts += 1;
      if (activationAttempts === 1) {
        currentReceipt = { ...receipt, syncId: "sync-b" };
        beforeDispatch();
        staleClicks += 1;
        return;
      }
      beforeDispatch();
      currentClicks += 1;
    });

    await verifyRecoveredExcelGrid(
      options({ currentReceipt: () => currentReceipt, findCurrentTarget, bindExactApp, activateElementOnce })
    );

    expect(findCurrentTarget.mock.calls.map(([observed]) => observed.syncId)).toEqual(["sync-a", "sync-b"]);
    expect(bindExactApp).toHaveBeenCalledTimes(2);
    expect(activateElementOnce).toHaveBeenCalledTimes(2);
    expect(staleClicks).toBe(0);
    expect(currentClicks).toBe(1);
  });

  it("never retries after receipt drift makes a dispatched click indeterminate", async () => {
    let currentReceipt = receipt;
    let activationAttempts = 0;
    const findCurrentTarget = vi.fn(async () => "target");
    const bindExactApp = vi.fn(async () => fakeApp());
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      activationAttempts += 1;
      beforeDispatch();
      if (activationAttempts === 1) {
        currentReceipt = { ...receipt, syncId: "sync-b" };
        throw new Error("receipt changed after the trusted click");
      }
    });

    await expect(
      verifyRecoveredExcelGrid(
        options({ currentReceipt: () => currentReceipt, findCurrentTarget, bindExactApp, activateElementOnce })
      )
    ).rejects.toThrow("receipt changed after the trusted click");

    expect(findCurrentTarget).toHaveBeenCalledOnce();
    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(activateElementOnce).toHaveBeenCalledOnce();
  });

  it("rejects receipt drift after activation returns normally", async () => {
    let currentReceipt = receipt;
    const findCurrentTarget = vi.fn(async () => "target");
    const bindExactApp = vi.fn(async () => fakeApp());
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      beforeDispatch();
      currentReceipt = { ...receipt, syncId: "sync-b" };
    });

    await expect(
      verifyRecoveredExcelGrid(
        options({ currentReceipt: () => currentReceipt, findCurrentTarget, bindExactApp, activateElementOnce })
      )
    ).rejects.toThrow("The recovered XLSX renderer receipt must not change after its trusted cell activation.");

    expect(findCurrentTarget).toHaveBeenCalledOnce();
    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(activateElementOnce).toHaveBeenCalledOnce();
  });

  it("rejects target retirement after activation returns normally", async () => {
    let retired = false;
    const findCurrentTarget = vi.fn(async () => "target");
    const bindExactApp = vi.fn(async () => fakeApp());
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      beforeDispatch();
      retired = true;
    });

    await expect(
      verifyRecoveredExcelGrid(
        options({ findCurrentTarget, bindExactApp, activateElementOnce, targetIsRetired: () => retired })
      )
    ).rejects.toThrow("The recovered XLSX renderer must remain live after its trusted cell activation.");

    expect(findCurrentTarget).toHaveBeenCalledOnce();
    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(activateElementOnce).toHaveBeenCalledOnce();
  });

  it("rejects receipt drift caused by the ArrowRight action", async () => {
    let currentReceipt = receipt;
    const findCurrentTarget = vi.fn(async () => "target");
    const bindExactApp = vi.fn(async () => fakeApp());
    const activateElementOnce = vi.fn(async (_element, _timeoutMs: number, beforeDispatch: () => void) => {
      beforeDispatch();
    });
    const pressTargetKey = vi.fn(async () => {
      currentReceipt = { ...receipt, syncId: "sync-b" };
    });

    await expect(
      verifyRecoveredExcelGrid(
        options({
          currentReceipt: () => currentReceipt,
          findCurrentTarget,
          bindExactApp,
          activateElementOnce,
          pressTargetKey
        })
      )
    ).rejects.toThrow("The recovered XLSX renderer receipt must not change after ArrowRight.");

    expect(findCurrentTarget).toHaveBeenCalledOnce();
    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(activateElementOnce).toHaveBeenCalledOnce();
    expect(pressTargetKey).toHaveBeenCalledOnce();
  });

  it("checks target lifecycle around grid, activation, keyboard, and neighbor sampling", async () => {
    const assertTargetLifecycle = vi.fn();

    await verifyRecoveredExcelGrid(options({ assertTargetLifecycle }));

    expect(assertTargetLifecycle).toHaveBeenCalledTimes(5);
  });

  it("disposes the activation element when its focus sample throws", async () => {
    const activationDispose = vi.fn(async () => {});
    const bindExactApp = vi.fn(async () =>
      fakeApp({
        activationDispose,
        activationEvaluate: async () => {
          throw new Error("focus sample failed");
        }
      })
    );

    await expect(verifyRecoveredExcelGrid(options({ bindExactApp }))).rejects.toThrow("focus sample failed");

    expect(bindExactApp).toHaveBeenCalledOnce();
    expect(activationDispose).toHaveBeenCalledOnce();
  });

  it("fails before target discovery when the active session changes", async () => {
    const findCurrentTarget = vi.fn(async () => "target");
    await expect(
      verifyRecoveredExcelGrid(
        options({ activeSession: () => ({ sessionId: "replacement", metadata: { revision: 7 } }), findCurrentTarget })
      )
    ).rejects.toThrow("XLSX renderer recovery must retain the exact active session.");
    expect(findCurrentTarget).not.toHaveBeenCalled();
  });

  it("fails before renderer discovery when the confirmed revision drifts", async () => {
    const findCurrentTarget = vi.fn(async () => "target");
    await expect(
      verifyRecoveredExcelGrid(
        options({ activeSession: () => ({ sessionId: "session", metadata: { revision: 8 } }), findCurrentTarget })
      )
    ).rejects.toThrow("XLSX renderer recovery must retain the confirmed revision.");
    expect(findCurrentTarget).not.toHaveBeenCalled();
  });
});
