import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NumericVisualization } from "../shared/protocol";
import { NumericHistogram } from "../webviews/visualizations/NumericHistogram";

const visualization: NumericVisualization = {
  kind: "numeric",
  bins: [
    { min: 1, max: 2.5, count: 100 },
    { min: 2.5, max: 4, count: 1 }
  ],
  sampled: false
};

describe("NumericHistogram", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("ignores focus scrolling for one frame, then dismisses later ancestor scroll without moving focus", () => {
    let armFocusScroll: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      armFocusScroll = callback;
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(
      <div data-testid="vertical-scroller">
        <div data-testid="horizontal-scroller">
          <NumericHistogram visualization={visualization} compact onSelectBin={vi.fn()} />
        </div>
      </div>
    );

    const control = screen.getByRole("button", { name: /1-2\.5: 100 rows/u });
    act(() => control.focus());

    const firstTooltip = screen.getByRole("tooltip", {
      name: "1-2.5: 100 rows (99%); lower bound included, upper bound excluded"
    });
    expect(firstTooltip.childNodes[0]).toHaveTextContent("1-2.5: 100 rows");
    expect(firstTooltip.querySelector(".numericHistogramTooltipDetail")).toHaveTextContent(
      "(99%); lower bound included, upper bound excluded"
    );

    const verticalScroller = screen.getByTestId("vertical-scroller");
    verticalScroller.scrollTop = 20;
    fireEvent.scroll(verticalScroller);
    expect(screen.getByRole("tooltip")).toBeVisible();
    expect(document.activeElement).toBe(control);

    act(() => armFocusScroll?.(0));
    verticalScroller.scrollTop = 40;
    fireEvent.scroll(verticalScroller);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);

    fireEvent.keyDown(control, { key: "ArrowRight" });
    expect(screen.getByRole("tooltip", { name: /2\.5-4: 1 row.*both bounds included/u })).toHaveTextContent(
      "2.5-4: 1 row"
    );

    const horizontalScroller = screen.getByTestId("horizontal-scroller");
    horizontalScroller.scrollLeft = 20;
    fireEvent.scroll(horizontalScroller);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);

    fireEvent.keyDown(control, { key: "Home" });
    expect(screen.getByRole("tooltip", { name: /1-2\.5: 100 rows/u })).toBeVisible();
  });

  it("dismisses visual tooltips when the viewport, document visibility, or histogram view changes", () => {
    const { rerender } = render(
      <NumericHistogram
        visualization={visualization}
        compact
        valueMode="percent"
        percentDenominator={101}
        onSelectBin={vi.fn()}
      />
    );
    const control = screen.getByRole("button", { name: /1-2\.5: 99% \(100 rows\)/u });

    act(() => control.focus());
    expect(screen.getByRole("tooltip", { name: /lower bound included/u })).toHaveTextContent("1-2.5: 99%");

    fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);

    fireEvent.keyDown(control, { key: "End" });
    expect(screen.getByRole("tooltip", { name: /both bounds included/u })).toBeVisible();
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);

    fireEvent.keyDown(control, { key: "Home" });
    expect(screen.getByRole("tooltip")).toBeVisible();
    rerender(
      <NumericHistogram
        visualization={{ ...visualization, bins: [{ min: 10, max: 20, count: 3 }] }}
        compact
        valueMode="percent"
        percentDenominator={3}
        onSelectBin={vi.fn()}
      />
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);
  });

  it("arms scroll dismissal immediately when pointer hover follows focus", () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    render(
      <div data-testid="scroller">
        <NumericHistogram visualization={visualization} compact onSelectBin={vi.fn()} />
      </div>
    );
    const control = screen.getByRole("button", { name: /1-2\.5: 100 rows/u });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 160, top: 0, bottom: 36, width: 160, height: 36, x: 0, y: 0 })
    });

    act(() => control.focus());
    fireEvent.pointerMove(control, { clientX: 120 });
    expect(screen.getByRole("tooltip", { name: /2\.5-4: 1 row/u })).toBeVisible();

    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(control);
  });

  it("confines compact tooltip copy to one truncated line", () => {
    const stylesheet = readFileSync(resolve("src/webviews/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /\.numericHistogram\.compact \.numericHistogramTooltip\s*\{[^}]*overflow:\s*hidden;[^}]*overflow-wrap:\s*normal;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/u
    );
    expect(stylesheet).toMatch(
      /\.numericHistogramTooltipDetail\s*\{[^}]*clip:\s*rect\(0 0 0 0\);[^}]*height:\s*1px;[^}]*overflow:\s*hidden;[^}]*position:\s*absolute;[^}]*width:\s*1px;/u
    );
  });
});
