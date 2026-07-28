import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  measureRendererGridScroll,
  type RendererGridMeasurementElement,
  type RendererGridMeasurementRuntime,
  type RendererGridScrollMeasurementInput
} from "./extensionHost/rendererGridScrollMeasurement";

interface MutableStyle {
  display: string;
  visibility: string;
  opacity: string;
}

class FakeElement implements RendererGridMeasurementElement {
  isConnected = true;
  parentElement: FakeElement | null = null;
  textContent: string | null = null;
  scrollTop = 0;
  rectangle = { top: 0, right: 800, bottom: 600, left: 0, width: 800, height: 600 };
  readonly attributes = new Map<string, string>();
  readonly style: MutableStyle = { display: "block", visibility: "visible", opacity: "1" };

  contains(other: RendererGridMeasurementElement): boolean {
    let current: RendererGridMeasurementElement | null = other;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  getBoundingClientRect() {
    return this.rectangle;
  }
}

class FakeRuntime implements RendererGridMeasurementRuntime {
  now = 0;
  readonly animationFrames = new Map<number, (timestamp: number) => void>();
  readonly timers = new Map<number, () => void>();
  readonly scroller = new FakeElement();
  readonly grid = new FakeElement();
  readonly cell = new FakeElement();
  readonly innerWidth = 1024;
  readonly innerHeight = 768;
  readonly performance = { now: (): number => this.now };
  private nextHandle = 1;

  constructor() {
    this.grid.parentElement = this.scroller;
    this.cell.parentElement = this.grid;
    this.grid.attributes.set("aria-busy", "false");
    this.grid.attributes.set("aria-rowcount", "1001");
    this.grid.attributes.set("aria-colcount", "51");
    this.cell.textContent = "400";
    this.cell.rectangle = { top: 100, right: 120, bottom: 129, left: 20, width: 100, height: 29 };
  }

  readonly document = {
    documentElement: { clientWidth: 1024, clientHeight: 768 },
    querySelector: (selector: string): FakeElement | null => {
      if (selector === '[data-testid="data-grid-scroller"]') return this.scroller;
      if (selector === 'table[role="grid"]') return this.grid;
      if (selector === '[data-grid-row="400"][data-grid-column="0"]') return this.cell;
      return null;
    }
  };

  requestAnimationFrame(callback: (timestamp: number) => void): number {
    const handle = this.nextHandle++;
    this.animationFrames.set(handle, callback);
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    this.animationFrames.delete(handle);
  }

  setTimeout(callback: () => void, _timeoutMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, callback);
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  getComputedStyle(element: RendererGridMeasurementElement): MutableStyle {
    return (element as FakeElement).style;
  }

  advanceFrame(milliseconds = 16): void {
    this.now += milliseconds;
    const callbacks = [...this.animationFrames.values()];
    this.animationFrames.clear();
    for (const callback of callbacks) callback(this.now);
  }

  expire(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }
}

const input: RendererGridScrollMeasurementInput = {
  row: 400,
  column: 0,
  totalRows: 1_000,
  totalColumns: 50,
  expectedText: "400",
  rowHeight: 29,
  timeoutMs: 1_000
};

describe("renderer-local grid scroll measurement", () => {
  it("serializes as one closure-free renderer function", async () => {
    const runtime = new FakeRuntime();
    const isolatedMeasurement = runInNewContext(`(${measureRendererGridScroll.toString()})`) as (
      request: RendererGridScrollMeasurementInput,
      renderer: RendererGridMeasurementRuntime
    ) => Promise<number>;
    const measurement = isolatedMeasurement(input, runtime);

    runtime.advanceFrame();
    runtime.advanceFrame();

    await expect(measurement).resolves.toBe(32);
  });

  it("starts at the scroll assignment and waits for two matching animation frames", async () => {
    const runtime = new FakeRuntime();
    runtime.now = 7;
    const measurement = measureRendererGridScroll(input, runtime);
    let result: number | undefined;
    void measurement.then((duration) => {
      result = duration;
    });

    expect(runtime.scroller.scrollTop).toBe(11_600);
    runtime.advanceFrame(23);
    await Promise.resolve();
    expect(result).toBeUndefined();

    runtime.advanceFrame(17);
    await measurement;
    expect(result).toBe(40);
    expect(runtime.animationFrames.size).toBe(0);
    expect(runtime.timers.size).toBe(0);
  });

  it("does not accept mismatched text, hidden cells, or zero-area geometry", async () => {
    const runtime = new FakeRuntime();
    runtime.cell.textContent = "stale";
    const measurement = measureRendererGridScroll(input, runtime);
    let settled = false;
    void measurement.then(() => {
      settled = true;
    });

    runtime.advanceFrame();
    runtime.cell.textContent = "400";
    runtime.cell.style.visibility = "hidden";
    runtime.advanceFrame();
    runtime.cell.style.visibility = "visible";
    runtime.cell.rectangle = { top: 100, right: 20, bottom: 100, left: 20, width: 0, height: 0 };
    runtime.advanceFrame();
    await Promise.resolve();
    expect(settled).toBe(false);

    runtime.cell.rectangle = { top: 100, right: 120, bottom: 129, left: 20, width: 100, height: 29 };
    runtime.advanceFrame();
    await Promise.resolve();
    expect(settled).toBe(false);
    runtime.advanceFrame();
    await measurement;
    expect(settled).toBe(true);
  });

  it("cancels the pending animation frame when its bounded timeout expires", async () => {
    const runtime = new FakeRuntime();
    runtime.cell.textContent = "never";
    const measurement = measureRendererGridScroll(input, runtime);

    expect(runtime.animationFrames.size).toBe(1);
    expect(runtime.timers.size).toBe(1);
    runtime.expire();

    await expect(measurement).rejects.toThrow(/did not visibly commit 1000 rows/u);
    expect(runtime.animationFrames.size).toBe(0);
    expect(runtime.timers.size).toBe(0);
  });

  it("cleans up when a renderer DOM read fails", async () => {
    const runtime = new FakeRuntime();
    runtime.getComputedStyle = () => {
      throw new Error("detached style context");
    };
    const measurement = measureRendererGridScroll(input, runtime);

    runtime.advanceFrame();

    await expect(measurement).rejects.toThrow("detached style context");
    expect(runtime.animationFrames.size).toBe(0);
    expect(runtime.timers.size).toBe(0);
  });
});
