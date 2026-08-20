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

  it("keeps every bar visible while pointer and keyboard share the active-bin status", () => {
    const { container } = render(<NumericHistogram visualization={visualization} compact onSelectBin={vi.fn()} />);
    const control = screen.getByRole("button", { name: /1-2\.5: 100 rows/u });
    const status = container.querySelector<HTMLElement>(".miniChartCaption");
    const bins = [...container.querySelectorAll<SVGGElement>(".numericHistogramBin")];
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 160, top: 0, bottom: 36, width: 160, height: 36, x: 0, y: 0 })
    });

    expect(status).toHaveTextContent("1 to 4 · 2 bins");
    expect(bins).toHaveLength(2);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

    act(() => control.focus());
    expect(status).toHaveTextContent("1-2.5: 100 rows");
    expect(bins[0]).toHaveClass("active");
    expect(bins[1]).not.toHaveClass("active");

    fireEvent.pointerMove(control, { clientX: 120 });
    expect(status).toHaveTextContent("2.5-4: 1 row");
    expect(bins[0]).not.toHaveClass("active");
    expect(bins[1]).toHaveClass("active");
    expect(control).toHaveAccessibleName("2.5-4: 1 row (1%); both bounds included");

    fireEvent.pointerLeave(control);
    expect(status).toHaveTextContent("1-2.5: 100 rows");
    expect(bins[0]).toHaveClass("active");

    fireEvent.keyDown(control, { key: "ArrowRight" });
    expect(status).toHaveTextContent("2.5-4: 1 row");
    expect(bins[1]).toHaveClass("active");
    expect(document.activeElement).toBe(control);

    fireEvent.scroll(window);
    expect(status).toHaveTextContent("2.5-4: 1 row");
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("keeps the visible caption aligned with the selected value mode and control label", () => {
    const { container, rerender } = render(
      <NumericHistogram
        visualization={visualization}
        compact
        valueMode="percent"
        percentDenominator={101}
        onSelectBin={vi.fn()}
      />
    );
    const control = screen.getByRole("button", { name: /1-2\.5: 99% \(100 rows\)/u });
    const status = container.querySelector<HTMLElement>(".miniChartCaption");

    act(() => control.focus());
    expect(status).toHaveTextContent("1-2.5: 99%");
    expect(status).toHaveAttribute("title", "1-2.5: 99% (100 rows); lower bound included, upper bound excluded");
    expect(control.getAttribute("aria-label")?.startsWith(status?.textContent ?? "unavailable")).toBe(true);
    expect(status).not.toHaveAttribute("role");
    expect(status).not.toHaveAttribute("aria-live");

    fireEvent.keyDown(control, { key: "End" });
    expect(status).toHaveTextContent("2.5-4: 1%");
    expect(control).toHaveAccessibleName("2.5-4: 1% (1 row); both bounds included");
    expect(control.getAttribute("aria-label")?.startsWith(status?.textContent ?? "unavailable")).toBe(true);

    rerender(
      <NumericHistogram
        visualization={{ ...visualization, bins: [{ min: 10, max: 20, count: 3 }] }}
        compact
        valueMode="percent"
        percentDenominator={3}
        onSelectBin={vi.fn()}
      />
    );
    expect(status).toHaveTextContent("10 to 20 · 1 bins");
    expect(status).not.toHaveClass("active");
    expect(control).toHaveAccessibleName("10-20: 100% (3 rows); both bounds included");
    expect(document.activeElement).toBe(control);
  });

  it("selects the same active bin with pointer and keyboard input", () => {
    const onSelectBin = vi.fn();
    render(<NumericHistogram visualization={visualization} compact onSelectBin={onSelectBin} />);
    const control = screen.getByRole("button", { name: /1-2\.5: 100 rows/u });
    Object.defineProperty(control, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 0, right: 160, top: 0, bottom: 36, width: 160, height: 36, x: 0, y: 0 })
    });

    fireEvent.pointerMove(control, { clientX: 120 });
    fireEvent.click(control, { clientX: 120, detail: 1 });
    expect(onSelectBin).toHaveBeenLastCalledWith(visualization.bins[1], 1);

    act(() => control.focus());
    fireEvent.keyDown(control, { key: "Home" });
    fireEvent.keyDown(control, { key: "Enter" });
    expect(onSelectBin).toHaveBeenLastCalledWith(visualization.bins[0], 0);
  });

  it("keeps the active status in the existing single-line caption space", () => {
    const stylesheet = readFileSync(resolve("src/webviews/styles.css"), "utf8");
    expect(stylesheet).toMatch(
      /\.miniChartCaption\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/u
    );
    expect(stylesheet).toMatch(
      /\.miniChartCaption\.active\s*\{[^}]*color:\s*var\(--vscode-foreground\);[^}]*font-variant-numeric:\s*tabular-nums;/u
    );
    expect(stylesheet).toMatch(
      /\.numericHistogramHitTarget:not\(:disabled\):hover\s*\{[^}]*background:\s*transparent;/u
    );
    expect(stylesheet).toMatch(
      /th\s*\{[^}]*background-color:\s*var\(--vscode-editor-background\);[^}]*background-image:\s*linear-gradient\(var\(--grid-header-surface\),\s*var\(--grid-header-surface\)\);[^}]*isolation:\s*isolate;[^}]*overflow:\s*clip;[^}]*z-index:\s*3;/u
    );
    expect(stylesheet).toMatch(/\.columnInsight\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*clip;/u);
    expect(stylesheet).toMatch(/\.summaryDistribution\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*clip;/u);
    expect(stylesheet).not.toContain(".numericHistogramTooltip");
  });
});
