import { describe, expect, it } from "vitest";
import {
  measureRendererGridScroll,
  type RendererGridMeasurementElement,
  type RendererGridMeasurementRuntime,
  type RendererGridScrollMeasurementInput
} from "./extensionHost/rendererGridScrollMeasurement";

const rectangle = { top: 0, right: 100, bottom: 29, left: 0, width: 100, height: 29 };

type MutableGridElement = Omit<RendererGridMeasurementElement, "textContent" | "getAttribute"> & {
  textContent: string | null;
  getAttribute(name: string): string | null;
};

function createElement(parentElement: RendererGridMeasurementElement | null = null): MutableGridElement {
  const element: MutableGridElement = {
    isConnected: true,
    clientHeight: 600,
    parentElement,
    textContent: null,
    scrollTop: 0,
    contains(other) {
      let current: RendererGridMeasurementElement | null = other;
      while (current) {
        if (current === element) return true;
        current = current.parentElement;
      }
      return false;
    },
    getAttribute: () => null,
    getBoundingClientRect: () => rectangle
  };
  return element;
}

class ImmediateGridRuntime implements RendererGridMeasurementRuntime {
  now = 0;
  observationCostMs = 0;
  styleReadCount = 0;
  geometryReadCount = 0;
  cellPresent = true;
  readonly scroller = createElement();
  readonly grid = createElement(this.scroller);
  readonly cell = createElement(this.grid);
  readonly innerWidth = 800;
  readonly innerHeight = 600;
  readonly performance = { now: (): number => this.now };
  private animationFrame: ((timestamp: number) => void) | undefined;

  constructor() {
    this.cell.textContent = "400";
    this.grid.getAttribute = (name) =>
      ({ "aria-busy": "false", "aria-rowcount": "1001", "aria-colcount": "51" })[name] ?? null;
    this.scroller.getBoundingClientRect = () => this.readRectangle();
    this.cell.getBoundingClientRect = () => this.readRectangle();
  }

  readonly document = {
    documentElement: { clientWidth: 800, clientHeight: 600 },
    querySelector: (selector: string): RendererGridMeasurementElement | null => {
      if (selector === '[data-testid="data-grid-scroller"]') return this.scroller;
      if (selector === 'table[role="grid"]') return this.grid;
      if (selector === '[data-grid-row="400"][data-grid-column="0"]') return this.cellPresent ? this.cell : null;
      return null;
    }
  };

  requestAnimationFrame(callback: (timestamp: number) => void): number {
    this.animationFrame = callback;
    return 1;
  }

  cancelAnimationFrame(): void {
    this.animationFrame = undefined;
  }

  setTimeout(): number {
    return 2;
  }

  clearTimeout(): void {}

  getComputedStyle(): { display: string; visibility: string; opacity: string } {
    this.styleReadCount += 1;
    this.now += this.observationCostMs;
    return { display: "block", visibility: "visible", opacity: "1" };
  }

  advanceFrame(timestamp: number, callbackNow = timestamp): void {
    this.now = callbackNow;
    const callback = this.animationFrame;
    this.animationFrame = undefined;
    callback?.(timestamp);
  }

  private readRectangle(): typeof rectangle {
    this.geometryReadCount += 1;
    this.now += this.observationCostMs;
    return rectangle;
  }
}

const input: RendererGridScrollMeasurementInput = {
  row: 400,
  column: 0,
  totalRows: 1_000,
  totalColumns: 50,
  expectedText: "400",
  rowHeight: 29,
  maximumCanvasHeight: 16_000_000,
  timeoutMs: 1_000
};

describe("cached renderer grid scroll timing", () => {
  it("reports the first candidate-ready rAF without charging observation work", async () => {
    const runtime = new ImmediateGridRuntime();
    runtime.observationCostMs = 5;
    runtime.cellPresent = false;
    const measurement = measureRendererGridScroll(input, runtime);

    expect([runtime.styleReadCount, runtime.geometryReadCount]).toEqual([0, 0]);
    runtime.advanceFrame(40, 47);

    runtime.cellPresent = true;
    runtime.cell.textContent = "stale";
    runtime.advanceFrame(80, 87);
    expect([runtime.styleReadCount, runtime.geometryReadCount]).toEqual([0, 0]);

    runtime.cell.textContent = "400";
    runtime.advanceFrame(120, 127);
    expect(runtime.styleReadCount).toBeGreaterThan(0);
    expect(runtime.geometryReadCount).toBeGreaterThan(0);
    runtime.advanceFrame(160, 167);

    await expect(measurement).resolves.toBe(120);
  });

  it("forgets an earlier matching frame when the target stops matching", async () => {
    const runtime = new ImmediateGridRuntime();
    const measurement = measureRendererGridScroll(input, runtime);

    runtime.advanceFrame(50);
    runtime.cell.textContent = "stale";
    runtime.advanceFrame(100);
    runtime.cell.textContent = "400";
    runtime.advanceFrame(150);
    runtime.advanceFrame(200);

    await expect(measurement).resolves.toBe(150);
  });
});
