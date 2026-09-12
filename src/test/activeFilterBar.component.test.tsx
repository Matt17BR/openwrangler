import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { SessionMetadata, TypedSelectionToken } from "../shared/protocol";
import { ActiveFilterBar, type FilterBarRequestLifecycle } from "../webviews/filters/ActiveFilterBar";

const metadata: SessionMetadata = {
  protocolVersion: 4,
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

interface FocusViewState {
  model: FilterModel;
  canUndo: boolean;
  requestLifecycle?: FilterBarRequestLifecycle;
  disabled?: boolean;
  retainVisible?: boolean;
}

interface FocusViewProps extends FocusViewState {
  onApply(model: FilterModel): string | undefined;
  onUndo(): string | undefined;
}

function FocusView({
  model,
  canUndo,
  requestLifecycle,
  onApply,
  onUndo,
  disabled = false,
  retainVisible = false
}: FocusViewProps) {
  return (
    <>
      <ActiveFilterBar
        metadata={metadata}
        model={model}
        canUndo={canUndo}
        disabled={disabled}
        retainVisible={retainVisible}
        requestLifecycle={requestLifecycle}
        onApply={onApply}
        onUndo={onUndo}
      />
      <div data-testid="data-grid-scroller">
        <button type="button" data-grid-row tabIndex={0}>
          Grid row
        </button>
      </div>
    </>
  );
}

function renderFocusSequence(initial: FocusViewState, requestIds = { apply: "clear-request", undo: "undo-request" }) {
  const onApply = vi.fn(() => requestIds.apply);
  const onUndo = vi.fn(() => requestIds.undo);
  const view = (state: FocusViewState) => <FocusView {...state} onApply={onApply} onUndo={onUndo} />;
  const rendered = render(view(initial));
  return {
    rerender: (next: FocusViewState) => rendered.rerender(view(next))
  };
}

const duplicateColumnModel: FilterModel = {
  logic: "or",
  filters: [
    {
      column: "city",
      type: "string",
      logic: "and",
      valueFilter: { kind: "values", selectedValues: ["Milan"], includeNulls: true, includeNaN: false },
      predicates: [{ kind: "predicate", operator: "notEquals", value: "Berlin" }]
    },
    { column: "city", type: "string", predicates: [{ kind: "predicate", operator: "notEquals", value: "Rome" }] },
    { column: "sales", type: "float", predicates: [{ kind: "predicate", operator: "gt", value: 10 }] }
  ],
  sort: [{ column: "sales", direction: "desc", nulls: "last" }]
};

describe("ActiveFilterBar", () => {
  it.each(["and", "or"] as const)("removes only the selected same-column entry with %s logic", (logic) => {
    const [first, sibling, sales] = duplicateColumnModel.filters;
    const model: FilterModel = {
      ...duplicateColumnModel,
      logic,
      filters: logic === "and" ? [first, sibling, sales] : [sibling, first, sales]
    };
    const original = JSON.stringify(model);
    const onApply = vi.fn();
    const view = (current: FilterModel) => (
      <ActiveFilterBar metadata={metadata} model={current} canUndo={false} onApply={onApply} onUndo={() => undefined} />
    );
    const rendered = render(view(model));
    const withoutValue = { ...first, valueFilter: { ...first.valueFilter!, selectedValues: [] } };
    const withoutFlags = { column: first.column, type: first.type, logic: first.logic, predicates: first.predicates };
    const removals = [
      { label: 'Remove equals "Milan" filter from city', entry: withoutValue },
      { label: "Remove is null filter from city", entry: withoutFlags },
      { label: 'Remove does not equal "Berlin" filter from city', entry: undefined }
    ];
    for (const removal of removals) {
      fireEvent.click(screen.getByRole("button", { name: removal.label }));
      const next = onApply.mock.lastCall![0] as FilterModel;
      const filters = removal.entry
        ? logic === "and"
          ? [removal.entry, sibling, sales]
          : [sibling, removal.entry, sales]
        : [sibling, sales];
      expect(next).toEqual({ ...model, filters });
      expect(next.filters).toContain(sibling);
      expect(next.filters.at(-1)).toBe(sales);
      expect(next.sort).toBe(model.sort);
      expect(JSON.stringify(model)).toBe(original);
      rendered.rerender(view(next));
      expect(screen.queryByRole("button", { name: removal.label })).not.toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: 'Remove does not equal "Rome" filter from city' })).toBeVisible();
    expect(screen.getByText(`2 filtered columns; match ${logic === "or" ? "any" : "all"}`)).toBeVisible();
  });

  it("removes every rendered same-column group after a whole-column clear", () => {
    const onApply = vi.fn();
    const view = (current: FilterModel) => (
      <ActiveFilterBar metadata={metadata} model={current} canUndo={false} onApply={onApply} onUndo={() => undefined} />
    );
    const rendered = render(view(duplicateColumnModel));

    rendered.rerender(view({ ...duplicateColumnModel, filters: [duplicateColumnModel.filters[2]] }));
    expect(screen.queryAllByRole("group", { name: /city filters/u })).toHaveLength(0);
    expect(screen.getByRole("group", { name: "sales filters" })).toBeVisible();
    expect(screen.getByText("1 filtered column; match any")).toBeVisible();
  });

  it("keeps every typed filter visible and removes rules individually without changing sorts", () => {
    const onApply = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState(activeModel);
      const [requestLifecycle, setRequestLifecycle] = useState<FilterBarRequestLifecycle>({});
      return (
        <ActiveFilterBar
          metadata={metadata}
          model={model}
          canUndo={false}
          requestLifecycle={requestLifecycle}
          onApply={(next) => {
            onApply(next);
            setModel(next);
            setRequestLifecycle({ settledRequestId: "rule-removal" });
            return "rule-removal";
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

  it("restores focus when the initiating request moves from disabled to settled", () => {
    const emptyModel = { ...activeModel, filters: [] } satisfies FilterModel;
    const sequence = renderFocusSequence({ model: activeModel, canUndo: false });

    const clear = screen.getByRole("button", { name: "Clear filters" });
    clear.focus();
    fireEvent.click(clear);
    sequence.rerender({
      model: emptyModel,
      canUndo: false,
      disabled: true,
      retainVisible: true,
      requestLifecycle: { pendingRequestId: "clear-request" }
    });
    expect(screen.getByRole("region", { name: "Viewing filters" })).toHaveFocus();
    sequence.rerender({
      model: emptyModel,
      canUndo: true,
      retainVisible: true,
      requestLifecycle: { settledRequestId: "clear-request" }
    });
    expect(screen.getByRole("button", { name: "Undo latest filter" })).toHaveFocus();
  });

  it("returns a failed clear to Clear even when filter undo was already available", () => {
    const emptyModel = { ...activeModel, filters: [] } satisfies FilterModel;
    const sequence = renderFocusSequence({ model: activeModel, canUndo: true });

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    sequence.rerender({
      model: emptyModel,
      canUndo: true,
      disabled: true,
      retainVisible: true,
      requestLifecycle: { pendingRequestId: "clear-request" }
    });
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      requestLifecycle: { settledRequestId: "clear-request" }
    });
    expect(screen.getByRole("button", { name: "Clear filters" })).toHaveFocus();
  });

  it("returns a failed filter undo to Undo", () => {
    const emptyModel = { ...activeModel, filters: [] } satisfies FilterModel;
    const sequence = renderFocusSequence({ model: activeModel, canUndo: true });

    fireEvent.click(screen.getByRole("button", { name: "Undo latest filter" }));
    sequence.rerender({
      model: emptyModel,
      canUndo: true,
      disabled: true,
      retainVisible: true,
      requestLifecycle: { pendingRequestId: "undo-request" }
    });
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      requestLifecycle: { settledRequestId: "undo-request" }
    });
    expect(screen.getByRole("button", { name: "Undo latest filter" })).toHaveFocus();
  });

  it("does not reclaim focus that moved deliberately while the request was pending", () => {
    const emptyModel = { ...activeModel, filters: [] } satisfies FilterModel;
    const sequence = renderFocusSequence({ model: activeModel, canUndo: true });

    fireEvent.click(screen.getByRole("button", { name: "Undo latest filter" }));
    sequence.rerender({
      model: emptyModel,
      canUndo: true,
      disabled: true,
      retainVisible: true,
      requestLifecycle: { pendingRequestId: "undo-request" }
    });
    const gridRow = screen.getByRole("button", { name: "Grid row" });
    gridRow.focus();
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      requestLifecycle: { settledRequestId: "undo-request" }
    });
    expect(gridRow).toHaveFocus();
  });

  it("drops stale focus restoration when a later page request supersedes the initiating request", () => {
    const sequence = renderFocusSequence(
      { model: activeModel, canUndo: true },
      { apply: "rule-request", undo: "undo-request" }
    );

    const chip = screen.getByRole("button", { name: 'Remove equals "Milan" (string) filter from city' });
    chip.focus();
    fireEvent.click(chip);
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      disabled: true,
      requestLifecycle: { pendingRequestId: "rule-request" }
    });
    expect(screen.getByRole("region", { name: "Viewing filters" })).toHaveFocus();
    const gridRow = screen.getByRole("button", { name: "Grid row" });
    gridRow.focus();
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      disabled: true,
      requestLifecycle: { pendingRequestId: "superseding-request" }
    });
    sequence.rerender({
      model: activeModel,
      canUndo: true,
      requestLifecycle: { settledRequestId: "superseding-request" }
    });
    expect(gridRow).toHaveFocus();
  });

  it("falls back to the grid after a correlated final filter undo", () => {
    const emptyModel = { ...activeModel, filters: [] } satisfies FilterModel;
    const sequence = renderFocusSequence({ model: activeModel, canUndo: true });

    fireEvent.click(screen.getByRole("button", { name: "Undo latest filter" }));
    sequence.rerender({
      model: emptyModel,
      canUndo: true,
      disabled: true,
      retainVisible: true,
      requestLifecycle: { pendingRequestId: "undo-request" }
    });
    sequence.rerender({
      model: emptyModel,
      canUndo: false,
      requestLifecycle: { settledRequestId: "undo-request" }
    });
    expect(screen.queryByRole("region", { name: "Viewing filters" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Grid row" })).toHaveFocus();
  });
});
