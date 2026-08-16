import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DataDiff } from "../shared/protocol";
import { StepInspectionPanel } from "../webviews/StepInspectionPanel";

const diff: DataDiff = {
  addedRows: 2,
  removedRows: 1,
  addedColumns: ["rounded"],
  removedColumns: ["raw"],
  changedCells: 3,
  cells: [],
  truncated: true
};

describe("StepInspectionPanel", () => {
  it("presents the pending range and clears through the supplied action", () => {
    const onClear = vi.fn();
    render(
      <StepInspectionPanel
        operationTitle="Round number"
        pendingOffset={200}
        pageSize={200}
        error="Could not inspect this step."
        onClear={onClear}
      />
    );

    expect(screen.getByText("Loading Round number")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Loading inspection rows 201 to 400…");
    expect(screen.getByRole("alert")).toHaveTextContent("Could not inspect this step.");
    expect(screen.getByText(/confirmed dataframe view and filters are unchanged/u)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Show confirmed data" }));
    expect(onClear).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledWith();
  });

  it("summarizes a completed diff and retains the unknown-step fallback", () => {
    render(<StepInspectionPanel pageSize={200} diff={diff} onClear={() => undefined} />);

    expect(screen.getByText("Inspecting applied step")).toBeVisible();
    expect(screen.queryByRole("status")).toBeNull();
    const summary = screen.getByLabelText("Selected step data diff summary");
    expect(summary).toHaveTextContent("+2 rows");
    expect(summary).toHaveTextContent("-1 rows");
    expect(summary).toHaveTextContent("+1 columns");
    expect(summary).toHaveTextContent("-1 columns");
    expect(summary).toHaveTextContent("3 changed cells in this block");
  });
});
