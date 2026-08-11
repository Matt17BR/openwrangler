import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { SessionMetadata, TypedSelectionToken } from "../shared/protocol";
import { ActiveFilterBar } from "../webviews/filters/ActiveFilterBar";

const metadata: SessionMetadata = {
  protocolVersion: 2,
  sessionId: "session",
  revision: 0,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 4, columns: 2 },
  filteredShape: { rows: 2, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

const typedMilan: TypedSelectionToken = {
  kind: "typedSelection",
  version: 1,
  columnType: "string",
  cell: { kind: "string", raw: "Milan", display: "Milan", isNull: false, isNaN: false }
};

const activeModel: FilterModel = {
  logic: "or",
  filters: [
    {
      column: "city",
      type: "string",
      logic: "or",
      valueFilter: {
        kind: "values",
        selectedValues: [typedMilan, "Paris"],
        includeNulls: false,
        includeNaN: false
      },
      predicates: []
    },
    {
      column: "sales",
      type: "float",
      logic: "and",
      valueFilter: {
        kind: "values",
        selectedValues: [],
        includeNulls: true,
        includeNaN: true
      },
      predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
    }
  ],
  sort: [{ column: "sales", direction: "desc", nulls: "last" }]
};

describe("ActiveFilterBar", () => {
  it("keeps every typed filter visible and removes rules individually without changing sorts", () => {
    const onApply = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState(activeModel);
      return (
        <ActiveFilterBar
          metadata={metadata}
          model={model}
          canUndo={false}
          onApply={(next) => {
            onApply(next);
            setModel(next);
          }}
          onUndo={() => undefined}
        />
      );
    };
    render(<Harness />);

    const bar = screen.getByRole("region", { name: "Viewing filters" });
    expect(within(bar).getByText("2 filtered columns; match any")).toBeVisible();
    const cityFilters = within(bar).getByRole("group", { name: "city filters" });
    const salesFilters = within(bar).getByRole("group", {
      name: "sales filters, match all conditions within this column"
    });
    expect(within(cityFilters).getByRole("group", { name: "city: match any selected value" })).toHaveTextContent(
      'Any valueequals "Milan" (string)equals "Paris"'
    );
    expect(within(salesFilters).getByRole("group", { name: "sales: match any selected value" })).toHaveTextContent(
      "Any valueis nullis NaN"
    );
    expect(cityFilters).toHaveTextContent("string");
    expect(salesFilters).toHaveTextContent("floatMatch all");
    expect(within(bar).getByRole("button", { name: 'Remove equals "Milan" (string) filter from city' })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Remove is null filter from sales" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Remove is NaN filter from sales" })).toBeVisible();
    expect(
      within(bar).getByRole("button", { name: "Remove is greater than 10 (number) filter from sales" })
    ).toBeVisible();

    const first = within(bar).getByRole("button", { name: 'Remove equals "Milan" (string) filter from city' });
    first.focus();
    fireEvent.click(first);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({
            column: "city",
            valueFilter: expect.objectContaining({ selectedValues: ["Paris"] })
          })
        ]),
        sort: activeModel.sort
      })
    );
    expect(within(bar).getByRole("button", { name: 'Remove equals "Paris" filter from city' })).toHaveFocus();
  });

  it("clears only filters and exposes a distinct keyboard-focusable filter undo", () => {
    const onApply = vi.fn();
    const onUndo = vi.fn();
    const rendered = render(
      <ActiveFilterBar metadata={metadata} model={activeModel} canUndo={true} onApply={onApply} onUndo={onUndo} />
    );

    const undo = screen.getByRole("button", { name: "Undo latest filter" });
    undo.focus();
    expect(undo).toHaveFocus();
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onApply).toHaveBeenLastCalledWith({ ...activeModel, filters: [] });

    rendered.rerender(
      <ActiveFilterBar
        metadata={metadata}
        model={{ ...activeModel, filters: [] }}
        canUndo={true}
        disabled={true}
        onApply={onApply}
        onUndo={onUndo}
      />
    );
    expect(screen.getByText("No active filters")).toBeVisible();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Undo latest filter" })).toBeDisabled();
    expect(screen.getByRole("region", { name: "Viewing filters" })).toHaveAttribute("aria-busy", "true");

    rendered.rerender(
      <ActiveFilterBar
        metadata={metadata}
        model={{ ...activeModel, filters: [] }}
        canUndo={false}
        onApply={onApply}
        onUndo={onUndo}
      />
    );
    expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument();
  });
});
