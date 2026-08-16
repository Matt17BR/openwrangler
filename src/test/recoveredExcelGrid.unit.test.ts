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

function gridGeometry(): Readonly<{ grid: unknown; cell: unknown; neighbor: unknown }> {
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
  const neighbor = { ...cell, dataset: { gridRow: "4", gridColumn: "4" } };
  documentState.hit = cell;
  ownerDocument.activeElement = neighbor;
  return { grid, cell, neighbor };
}

const receipt: RendererSynchronizationReceipt = { syncId: "sync-a", sessionId: "session", revision: 7 };

function fakeApp(): Locator {
  const activationHandle = {
    evaluate: async () => ({ connected: true, documentFocused: true, cellFocused: true }),
    dispose: vi.fn(async () => {})
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

  it("measures neighbor focus inside the data viewport below sticky headers", () => {
    const { neighbor } = gridGeometry();
    expect(measureRecoveredExcelNeighborExposure(neighbor)).toMatchObject({
      connected: true,
      focused: true,
      fullyExposed: true,
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
