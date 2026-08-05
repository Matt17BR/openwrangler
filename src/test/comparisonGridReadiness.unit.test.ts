import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_COMPARISON_GRID_READINESS_INPUT,
  observeComparisonGridReadiness,
  type ComparisonGridReadinessEvidence,
  type ComparisonGridReadinessInput,
  type ComparisonGridRuntime
} from "./extensionHost/comparisonGridReadiness";

class FrameRuntime {
  readonly callbacks: Array<(timestamp: number) => void> = [];
  readonly runtime: ComparisonGridRuntime;
  private handle = 0;

  constructor({ pointerUsable = true }: { pointerUsable?: boolean } = {}) {
    this.runtime = {
      document: {
        documentElement: document.documentElement,
        elementFromPoint: () =>
          (pointerUsable ? document.querySelector('[role="gridcell"], tbody td') : null) as unknown as ReturnType<
            ComparisonGridRuntime["document"]["elementFromPoint"]
          >,
        getElementById: (id) =>
          document.getElementById(id) as unknown as ReturnType<ComparisonGridRuntime["document"]["getElementById"]>,
        querySelectorAll: (selector) =>
          document.querySelectorAll(selector) as unknown as ReturnType<
            ComparisonGridRuntime["document"]["querySelectorAll"]
          >
      },
      innerWidth: 1_024,
      innerHeight: 768,
      requestAnimationFrame: (callback) => {
        this.callbacks.push(callback);
        this.handle += 1;
        return this.handle;
      },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" })
    };
  }

  advance(): void {
    const callbacks = this.callbacks.splice(0);
    for (const callback of callbacks) callback(this.handle * 16);
  }
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("clean-room comparison grid readiness", () => {
  it("accepts a stable visible generic ARIA grid with deterministic headers and cells", async () => {
    mountGrid();
    const frames = new FrameRuntime();
    const observation = observeComparisonGridReadiness(DEFAULT_COMPARISON_GRID_READINESS_INPUT, frames.runtime);

    frames.advance();
    await Promise.resolve();
    frames.advance();

    await expect(observation).resolves.toEqual({
      rootRole: "grid",
      busy: "false",
      visible: true,
      pointerUsable: true,
      geometryStableFrames: 2,
      headers: ["c00", "c01"],
      bodyContentMatched: true,
      ariaRowCount: 2_001,
      ariaColumnCount: 9
    });
  });

  it("accepts a native table without optional ARIA counts", async () => {
    mountGrid({ nativeTable: true, includeCounts: false, busy: null });
    const result = await observe();

    expect(result).toMatchObject({
      rootRole: "table",
      busy: "absent",
      pointerUsable: true,
      bodyContentMatched: true,
      ariaRowCount: null,
      ariaColumnCount: null
    });
  });

  it("recognizes exact visible leaf titles inside production-shaped composite headers", async () => {
    mountGrid({ nativeTable: true, compositeHeaders: true });

    await expect(observe()).resolves.toMatchObject({
      rootRole: "table",
      headers: ["c00", "c01"],
      bodyContentMatched: true
    });
  });

  it("aligns data cells when the generic grid exposes a row-header corner", async () => {
    mountGrid({ cornerRole: "rowheader" });

    await expect(observe()).resolves.toMatchObject({
      headers: ["c00", "c01"],
      bodyContentMatched: true
    });
  });

  it("rejects busy, hidden, malformed-count, and zero-geometry grids", async () => {
    mountGrid({ busy: "true" });
    await expect(observe()).resolves.toBeNull();

    document.body.replaceChildren();
    const hidden = mountGrid();
    hidden.style.display = "none";
    const hiddenRuntime = new FrameRuntime();
    hiddenRuntime.runtime.getComputedStyle = (element) => ({
      display: element === (hidden as unknown) ? "none" : "block",
      visibility: "visible",
      opacity: "1"
    });
    await expect(observeWithFrames(hiddenRuntime)).resolves.toBeNull();

    document.body.replaceChildren();
    mountGrid({ rowCount: "unknown" });
    await expect(observe()).resolves.toBeNull();

    document.body.replaceChildren();
    const zero = mountGrid();
    setRectangle(zero, { top: 0, right: 0, bottom: 0, left: 0, width: 0, height: 0 });
    await expect(observe()).resolves.toBeNull();
  });

  it("rejects a visible grid whose deterministic sentinel cell is occluded from pointer hit-testing", async () => {
    mountGrid();
    await expect(observeWithFrames(new FrameRuntime({ pointerUsable: false }))).resolves.toBeNull();
  });

  it("rejects product-specific-looking grids that do not expose the shared headers and sentinels", async () => {
    mountGrid({ secondHeader: "sales" });
    await expect(observe()).resolves.toBeNull();

    document.body.replaceChildren();
    mountGrid({ bottomRight: "3" });
    await expect(observe()).resolves.toBeNull();
  });

  it("accepts mixed-fixture headers with visible body data without assuming product-specific number formatting", async () => {
    mountGrid({
      firstHeader: "net_revenue_usd",
      secondHeader: "gross_margin_usd",
      topLeftValues: [
        ["null", "-387.884"],
        ["-146.978", "-683.902"]
      ]
    });
    const frames = new FrameRuntime();
    const observation = observeComparisonGridReadiness(
      {
        headers: ["net_revenue_usd", "gross_margin_usd"],
        bodyContent: { kind: "minimum-nonempty", count: 3 }
      },
      frames.runtime
    );

    frames.advance();
    await Promise.resolve();
    frames.advance();

    await expect(observation).resolves.toMatchObject({
      headers: ["net_revenue_usd", "gross_margin_usd"],
      bodyContentMatched: true
    });
  });

  it("rejects a mixed-fixture grid with fewer than three visible body values", async () => {
    mountGrid({
      firstHeader: "net_revenue_usd",
      secondHeader: "gross_margin_usd",
      topLeftValues: [
        ["", "one visible value"],
        ["", ""]
      ]
    });
    const frames = new FrameRuntime();
    const observation = observeComparisonGridReadiness(
      {
        headers: ["net_revenue_usd", "gross_margin_usd"],
        bodyContent: { kind: "minimum-nonempty", count: 3 }
      },
      frames.runtime
    );

    frames.advance();
    await Promise.resolve();
    frames.advance();

    await expect(observation).resolves.toBeNull();
  });

  it("requires matching visible geometry across two animation frames", async () => {
    const grid = mountGrid();
    const frames = new FrameRuntime();
    const observation = observeComparisonGridReadiness(DEFAULT_COMPARISON_GRID_READINESS_INPUT, frames.runtime);

    frames.advance();
    await Promise.resolve();
    setRectangle(grid, { top: 0, right: 640, bottom: 320, left: 0, width: 640, height: 320 });
    frames.advance();

    await expect(observation).resolves.toBeNull();
  });

  it("fails closed for a malformed readiness contract", async () => {
    mountGrid();
    const invalid = {
      headers: ["c00", "c00"],
      bodyContent: {
        kind: "exact",
        topLeftValues: [
          ["0", "1"],
          ["1", "2"]
        ]
      }
    } as unknown as ComparisonGridReadinessInput;
    const frames = new FrameRuntime();

    await expect(observeComparisonGridReadiness(invalid, frames.runtime)).resolves.toBeNull();
    expect(frames.callbacks).toHaveLength(0);
  });

  it("serializes as one closure-free frame function", async () => {
    mountGrid();
    const isolated = runInNewContext(`(${observeComparisonGridReadiness.toString()})`) as (
      input: ComparisonGridReadinessInput,
      runtime: ComparisonGridRuntime
    ) => Promise<ComparisonGridReadinessEvidence | null>;
    const frames = new FrameRuntime();
    const observation = isolated(DEFAULT_COMPARISON_GRID_READINESS_INPUT, frames.runtime);

    frames.advance();
    await Promise.resolve();
    frames.advance();

    await expect(observation).resolves.toMatchObject({
      rootRole: "grid",
      headers: ["c00", "c01"],
      bodyContentMatched: true,
      pointerUsable: true
    });
  });
});

async function observe(): Promise<ComparisonGridReadinessEvidence | null> {
  return observeWithFrames(new FrameRuntime());
}

async function observeWithFrames(frames: FrameRuntime): Promise<ComparisonGridReadinessEvidence | null> {
  const observation = observeComparisonGridReadiness(DEFAULT_COMPARISON_GRID_READINESS_INPUT, frames.runtime);
  frames.advance();
  await Promise.resolve();
  frames.advance();
  return observation;
}

function mountGrid(
  options: {
    nativeTable?: boolean;
    includeCounts?: boolean;
    busy?: string | null;
    rowCount?: string;
    firstHeader?: string;
    secondHeader?: string;
    bottomRight?: string;
    topLeftValues?: readonly [readonly [string, string], readonly [string, string]];
    cornerRole?: "columnheader" | "rowheader";
    compositeHeaders?: boolean;
  } = {}
): HTMLElement {
  const {
    nativeTable = false,
    includeCounts = true,
    busy = "false",
    rowCount = "2001",
    firstHeader = "c00",
    secondHeader = "c01",
    bottomRight = "2",
    topLeftValues = [
      ["0", "1"],
      ["1", bottomRight]
    ],
    cornerRole = "columnheader",
    compositeHeaders = false
  } = options;
  const root = document.createElement(nativeTable ? "table" : "div");
  if (!nativeTable) root.setAttribute("role", "grid");
  if (busy !== null) root.setAttribute("aria-busy", busy);
  if (includeCounts) {
    root.setAttribute("aria-rowcount", rowCount);
    root.setAttribute("aria-colcount", "9");
  }
  const headerMarkup = (name: string): string =>
    compositeHeaders
      ? `<div><span>${name}</span><details><summary aria-label="Column actions"></summary><div><button>Filter…</button><button>Sort ascending</button><button>Sort descending</button></div></details><button aria-label="Resize column"></button></div><small>Int64</small>`
      : name;
  root.innerHTML = nativeTable
    ? `
      <thead><tr><th></th><th>${headerMarkup(firstHeader)}</th><th>${headerMarkup(secondHeader)}</th></tr></thead>
      <tbody>
        <tr><th>1</th><td>${topLeftValues[0][0]}</td><td>${topLeftValues[0][1]}</td></tr>
        <tr><th>2</th><td>${topLeftValues[1][0]}</td><td>${topLeftValues[1][1]}</td></tr>
      </tbody>`
    : `
      <div role="row">
        <div role="${cornerRole}"></div>
        <div role="columnheader" aria-label="${firstHeader}, Int64 column">${firstHeader}</div>
        <div role="columnheader">${secondHeader}</div>
      </div>
      <div role="row">
        <div role="rowheader">1</div>
        <div role="gridcell">${topLeftValues[0][0]}</div>
        <div role="gridcell">${topLeftValues[0][1]}</div>
      </div>
      <div role="row">
        <div role="rowheader">2</div>
        <div role="gridcell">${topLeftValues[1][0]}</div>
        <div role="gridcell">${topLeftValues[1][1]}</div>
      </div>`;
  document.body.append(root);
  const rootHeight = compositeHeaders ? 600 : 300;
  setRectangle(root, { top: 0, right: 600, bottom: rootHeight, left: 0, width: 600, height: rootHeight });
  [...root.querySelectorAll("*")].forEach((element, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    setRectangle(element, {
      top: 20 + row * 32,
      right: 100 + column * 120,
      bottom: 48 + row * 32,
      left: column * 120,
      width: 100,
      height: 28
    });
  });
  return root;
}

type RectangleGeometry = Pick<DOMRectReadOnly, "top" | "right" | "bottom" | "left" | "width" | "height">;

function setRectangle(element: Element, rectangle: RectangleGeometry): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: rectangle.left,
      y: rectangle.top,
      top: rectangle.top,
      right: rectangle.right,
      bottom: rectangle.bottom,
      left: rectangle.left,
      width: rectangle.width,
      height: rectangle.height,
      toJSON: () => ({})
    })
  });
}
