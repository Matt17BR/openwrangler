import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, SessionMetadata, TypedSelectionToken, ValuesResponse } from "../shared/protocol";
import { FilterPanel } from "../webviews/filters/FilterPanel";
import { SummaryPanel } from "../webviews/summary/SummaryPanel";

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
  filteredShape: { rows: 4, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  stats: {
    missingCells: 1,
    missingRows: 1,
    duplicateRows: 1,
    missingValuesByColumn: [
      { column: "city", count: 0 },
      { column: "sales", count: 1 }
    ]
  },
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: true }
  ]
};

const values = new Map<string, ValuesResponse>([
  [
    "city",
    {
      kind: "columnValues",
      revision: 0,
      viewRequestId: "values-city",
      column: "city",
      values: [
        { value: "Berlin", count: 2 },
        { value: "Milan", count: 1 }
      ],
      hasMore: true
    }
  ]
]);

describe("FilterPanel", () => {
  it("renders its loading state without metadata", () => {
    render(
      <FilterPanel
        metadata={undefined}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        onApply={() => undefined}
        onRequestValues={() => undefined}
      />
    );
    expect(screen.getByText("Preparing filters...")).toBeInTheDocument();
  });

  it("builds advanced values, predicates, sorts, and clear actions", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    const model: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin"],
            includeNulls: false,
            includeNaN: false,
            search: ""
          },
          predicates: [{ kind: "predicate", operator: "contains", value: "er" }]
        }
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    };
    render(
      <FilterPanel
        metadata={metadata}
        model={model}
        values={values}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    fireEvent.change(screen.getByLabelText("Across columns"), { target: { value: "or" } });
    expect(onApply).toHaveBeenLastCalledWith(expect.objectContaining({ logic: "or" }));
    fireEvent.change(screen.getByPlaceholderText("Search values"), { target: { value: "mil" } });
    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    expect(onRequestValues).toHaveBeenCalledWith("city", "mil");
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    expect(screen.getByText(/More values available/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /Berlin/ }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.not.objectContaining({
            valueFilter: expect.anything()
          })
        ]
      })
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /Milan/ }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({ valueFilter: expect.objectContaining({ selectedValues: ["Berlin", "Milan"] }) })
        ]
      })
    );

    fireEvent.change(screen.getByLabelText("Condition combination"), { target: { value: "or" } });
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: [expect.objectContaining({ logic: "or" })] })
    );

    fireEvent.change(screen.getAllByLabelText("Column")[0], { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "between" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "10" } });
    fireEvent.change(screen.getByPlaceholderText("And"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.arrayContaining([
          expect.objectContaining({
            predicates: expect.arrayContaining([
              expect.objectContaining({ operator: "between", value: 10, secondValue: 20 })
            ])
          })
        ])
      })
    );

    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "isNull" } });
    expect(screen.queryByPlaceholderText("Value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));

    fireEvent.change(screen.getByLabelText("Sort direction"), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: "Update sort" }));
    expect(screen.getByRole("list", { name: "Active sort order" })).toHaveTextContent("salesdescending");

    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onApply).toHaveBeenLastCalledWith({ filters: [], sort: [] });
    fireEvent.click(screen.getByRole("button", { name: "Use basic filters" }));
    expect(screen.getByRole("button", { name: "Use advanced filters" })).toBeInTheDocument();
  });

  it("keeps deliberate multi-sort ordered, editable, individually removable, and separate from filters", () => {
    const initialModel: FilterModel = {
      logic: "or",
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "i" }]
        }
      ],
      sort: [
        { column: "city", direction: "asc", nulls: "last" },
        { column: "sales", direction: "desc", nulls: "last" }
      ]
    };
    const onApply = vi.fn();
    const Harness = () => {
      const [model, setModel] = useState(initialModel);
      return (
        <FilterPanel
          metadata={metadata}
          model={model}
          values={values}
          onApply={(next) => {
            onApply(next);
            setModel(next);
          }}
          onRequestValues={() => undefined}
        />
      );
    };
    render(<Harness />);

    const ordered = screen.getByRole("list", { name: "Active sort order" });
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("cityascending");
    expect(within(ordered).getAllByRole("listitem")[1]).toHaveTextContent("salesdescending");
    expect(screen.getByText(/Update this column in place without changing its priority/u)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Change sort 1, city, to descending" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("citydescending");
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove sort 2, sales, descending" }));
    expect(within(ordered).getAllByRole("listitem")).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply sort order" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        logic: "or",
        filters: initialModel.filters,
        sort: [{ column: "city", direction: "desc", nulls: "last" }]
      })
    );

    onApply.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Clear all sorts" }));
    expect(screen.getByText("No active sorts.")).toBeVisible();
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply sort order" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({ logic: "or", filters: initialModel.filters, sort: [] })
    );
  });

  it("keys ambiguous displays by typed selection identity while showing the display text", () => {
    const onApply = vi.fn();
    const numericSelection: TypedSelectionToken = {
      kind: "typedSelection",
      version: 1,
      columnType: "string",
      cell: { kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }
    };
    const mixedValues = new Map<string, ValuesResponse>([
      [
        "city",
        {
          kind: "columnValues",
          revision: 0,
          viewRequestId: "mixed-values",
          column: "city",
          values: [
            { value: "1", count: 4, selectionValue: numericSelection },
            { value: "1", count: 1 }
          ],
          hasMore: false
        }
      ]
    ]);
    const model: FilterModel = {
      filters: [
        {
          column: "city",
          type: "string",
          valueFilter: {
            kind: "values",
            selectedValues: [numericSelection],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: []
    };

    render(
      <FilterPanel
        metadata={metadata}
        model={model}
        values={mixedValues}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    const [numeric, text] = screen.getAllByRole("checkbox");
    expect(numeric).toBeChecked();
    expect(text).not.toBeChecked();
    expect(screen.getAllByText("1", { selector: ".checkboxRow > span" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Remove equals 1 (integer) filter from city" })).toBeInTheDocument();

    fireEvent.click(numeric);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: []
      })
    );
    fireEvent.click(text);
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({
            valueFilter: expect.objectContaining({ selectedValues: [numericSelection, "1"] })
          })
        ]
      })
    );
  });

  it("removes a final value filter structurally without disturbing a sort on the same column", () => {
    const onApply = vi.fn();
    const model: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "city",
          type: "string",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: [{ column: "city", direction: "asc", nulls: "last" }]
    };
    const rendered = render(
      <FilterPanel
        metadata={metadata}
        model={model}
        values={values}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: /Berlin/u }));
    expect(onApply).toHaveBeenLastCalledWith({
      logic: "and",
      filters: [],
      sort: [{ column: "city", direction: "asc", nulls: "last" }]
    });

    const emptyModel = onApply.mock.calls.at(-1)?.[0] as FilterModel;
    rendered.rerender(
      <FilterPanel
        metadata={metadata}
        model={emptyModel}
        values={values}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );
    onApply.mockClear();
    fireEvent.change(screen.getByLabelText("Condition combination"), { target: { value: "or" } });
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText("No active filters.")).toBeInTheDocument();
  });

  it("lists filters from every column and removes one value or predicate without clearing siblings or sorts", () => {
    const onApply = vi.fn();
    const model: FilterModel = {
      logic: "or",
      filters: [
        {
          column: "city",
          type: "string",
          logic: "and",
          valueFilter: {
            kind: "values",
            selectedValues: ["Berlin", "Milan"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: [{ kind: "predicate", operator: "contains", value: "i" }]
        },
        {
          column: "sales",
          type: "float",
          logic: "or",
          valueFilter: {
            kind: "values",
            selectedValues: [],
            includeNulls: true,
            includeNaN: false
          },
          predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
        }
      ],
      sort: [
        { column: "city", direction: "asc", nulls: "last" },
        { column: "sales", direction: "desc", nulls: "first" }
      ]
    };
    const rendered = render(
      <FilterPanel
        metadata={metadata}
        model={model}
        values={values}
        activeColumn="city"
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    expect(screen.getByRole("region", { name: "city filters" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "sales filters" })).toBeInTheDocument();
    expect(screen.getByText("2 filtered columns")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: 'Remove equals "Berlin" filter from city' }));
    const afterValueRemoval = onApply.mock.calls.at(-1)?.[0] as FilterModel;
    expect(afterValueRemoval.filters).toEqual([
      expect.objectContaining({
        column: "city",
        valueFilter: expect.objectContaining({ selectedValues: ["Milan"] }),
        predicates: [{ kind: "predicate", operator: "contains", value: "i" }]
      }),
      model.filters[1]
    ]);
    expect(afterValueRemoval.sort).toEqual(model.sort);

    rendered.rerender(
      <FilterPanel
        metadata={metadata}
        model={afterValueRemoval}
        values={values}
        activeColumn="city"
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: 'Remove contains "i" filter from city' }));
    const afterPredicateRemoval = onApply.mock.calls.at(-1)?.[0] as FilterModel;
    expect(afterPredicateRemoval.filters).toEqual([
      expect.objectContaining({
        column: "city",
        valueFilter: expect.objectContaining({ selectedValues: ["Milan"] }),
        predicates: []
      }),
      model.filters[1]
    ]);
    expect(afterPredicateRemoval.sort).toEqual(model.sort);

    rendered.rerender(
      <FilterPanel
        metadata={metadata}
        model={afterPredicateRemoval}
        values={values}
        activeColumn="city"
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filter for sales" }));
    expect(onApply).toHaveBeenLastCalledWith({
      ...afterPredicateRemoval,
      filters: [afterPredicateRemoval.filters[0]]
    });
    expect((onApply.mock.calls.at(-1)?.[0] as FilterModel).sort).toEqual(model.sort);
  });

  it("coerces predicate inputs according to the selected column type", () => {
    const onApply = vi.fn();
    const typedMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 3 },
      filteredShape: { rows: 4, columns: 3 },
      schema: [
        ...metadata.schema,
        { id: "c:2", name: "active", position: 2, rawType: "Boolean", type: "boolean", nullable: false }
      ]
    };
    render(
      <FilterPanel
        metadata={typedMetadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    const columnSelect = screen.getAllByLabelText("Column")[0];
    const operatorSelect = screen.getByLabelText("Predicate operator");

    fireEvent.change(operatorSelect, { target: { value: "equals" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: "12" }] })]
      })
    );

    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "TRUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: "TRUE" }] })]
      })
    );

    fireEvent.change(columnSelect, { target: { value: "c:1" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "12.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: 12.5 }] })]
      })
    );

    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "Infinity" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [
          expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: "Infinity" }] })
        ]
      })
    );

    fireEvent.change(columnSelect, { target: { value: "c:2" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: " TrUe " } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: true }] })]
      })
    );

    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator: "equals", value: false }] })]
      })
    );
  });

  it("emits null and NaN predicates without stray values", () => {
    const onApply = vi.fn();
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    for (const operator of ["isNull", "isNotNull"] as const) {
      fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: operator } });
      fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator }] })]
        })
      );
    }

    fireEvent.change(screen.getAllByLabelText("Column")[0]!, { target: { value: "c:1" } });
    for (const operator of ["isNaN", "isNotNaN"] as const) {
      fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: operator } });
      fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
      expect(onApply).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filters: [expect.objectContaining({ predicates: [{ kind: "predicate", operator }] })]
        })
      );
    }
  });

  it("offers only predicates supported by the selected column type", () => {
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={() => undefined}
        onRequestValues={() => undefined}
      />
    );

    const operatorSelect = screen.getByLabelText("Predicate operator") as HTMLSelectElement;
    const options = () => Array.from(operatorSelect.options, (option) => option.value);
    expect(options()).toContain("contains");
    expect(options()).not.toContain("isNaN");

    fireEvent.change(screen.getAllByLabelText("Column")[0]!, { target: { value: "c:1" } });
    expect(options()).toContain("isNaN");
    expect(options()).not.toContain("contains");
  });

  it("requires both bounds before adding a between predicate", () => {
    const onApply = vi.fn();
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={() => undefined}
      />
    );

    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "between" } });
    fireEvent.change(screen.getByPlaceholderText("Value"), { target: { value: "Berlin" } });
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText("And"), { target: { value: "Milan" } });
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeEnabled();
  });

  it("fails closed when stable columns share one displayed name", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    const ambiguousMetadata: SessionMetadata = {
      ...metadata,
      backend: "pandas",
      shape: { rows: 2, columns: 2 },
      filteredShape: { rows: 2, columns: 2 },
      schema: [
        { id: "c:number", name: "7", position: 0, rawType: "int64", type: "integer", nullable: false },
        { id: "c:string", name: "7", position: 1, rawType: "int64", type: "integer", nullable: false }
      ]
    };
    const ambiguousValues = new Map<string, ValuesResponse>([
      [
        "7",
        {
          kind: "columnValues",
          revision: 0,
          viewRequestId: "stale-ambiguous-values",
          column: "7",
          values: [{ value: "100", count: 2 }],
          hasMore: false
        }
      ]
    ]);

    render(
      <FilterPanel
        metadata={ambiguousMetadata}
        model={{ filters: [], sort: [] }}
        values={ambiguousValues}
        activeColumn="7"
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    expect(
      screen.getByText(
        'View filters, sorts, and values are unavailable because 2 columns share the displayed name "7". Rename one column in a cleaning step first.'
      )
    ).toHaveAttribute("role", "status");
    for (const select of screen.getAllByLabelText("Column")) {
      expect(within(select).getByRole("option", { name: "7 (column 1)" })).toBeInTheDocument();
      expect(within(select).getByRole("option", { name: "7 (column 2)" })).toBeInTheDocument();
      expect(select).toBeEnabled();
    }
    expect(screen.getByPlaceholderText("Search values")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: /100/u })).toBeNull();
    expect(screen.getByLabelText("Condition combination")).toBeDisabled();
    expect(screen.getByLabelText("Predicate operator")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    expect(screen.getByLabelText("Sort direction")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to sort" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear column" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeEnabled();

    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onRequestValues).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onApply).toHaveBeenLastCalledWith({ filters: [], sort: [] });
  });

  it("handles an empty schema without dispatching invalid filters", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    render(
      <FilterPanel
        metadata={{ ...metadata, schema: [], shape: { rows: 0, columns: 0 }, filteredShape: { rows: 0, columns: 0 } }}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        defaultAdvanced={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    expect(screen.getByPlaceholderText("Search values")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();
    expect(screen.getByLabelText("Condition combination")).toBeDisabled();
    expect(screen.getByLabelText("Predicate operator")).toBeDisabled();
    expect(screen.queryByPlaceholderText("Value")).toBeNull();
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear column" })).toBeDisabled();

    fireEvent.click(screen.getByText("SORTS"));
    for (const select of screen.getAllByLabelText("Column")) {
      expect(select).toBeDisabled();
      expect(select).toHaveValue("");
    }
    expect(screen.getByLabelText("Sort direction")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to sort" })).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    fireEvent.change(screen.getByLabelText("Condition combination"), { target: { value: "or" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onRequestValues).not.toHaveBeenCalled();
  });

  it("disables every filter action while a foreground mutation is pending", () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={values}
        defaultAdvanced={true}
        disabled={true}
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );

    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use basic filters" })).toBeDisabled();
    expect(screen.getByLabelText("Across columns")).toBeDisabled();
    expect(screen.getByPlaceholderText("Search values")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Values" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /Berlin/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add predicate" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear column" })).toBeDisabled();
    fireEvent.click(screen.getByText("SORTS"));
    expect(screen.getByLabelText("Sort direction")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to sort" })).toBeDisabled();

    fireEvent.keyDown(screen.getByPlaceholderText("Search values"), { key: "Enter" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Berlin/ }));
    fireEvent.click(screen.getByRole("button", { name: "Add predicate" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onRequestValues).not.toHaveBeenCalled();
  });

  it("keeps a selected non-first column by schema ID through rename and emits its current name", async () => {
    const onApply = vi.fn();
    const onRequestValues = vi.fn();
    const { rerender } = render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        activeColumn="city"
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );
    const sortDisclosure = screen.getByText("SORTS").closest("details");
    if (!sortDisclosure) throw new Error("Expected the sort disclosure.");
    fireEvent.click(screen.getByText("SORTS"));
    expect(sortDisclosure).toHaveAttribute("open");
    fireEvent.change(screen.getAllByLabelText("Column")[0], { target: { value: "c:1" } });
    for (const select of screen.getAllByLabelText("Column")) {
      expect(select).toHaveValue("c:1");
      expect(select).toHaveDisplayValue("sales");
    }
    fireEvent.change(screen.getByLabelText("Sort direction"), { target: { value: "desc" } });
    expect(sortDisclosure).toHaveAttribute("open");

    const renamedMetadata = {
      ...metadata,
      schema: metadata.schema.map((column) => (column.id === "c:1" ? { ...column, name: "revenue" } : column))
    };
    rerender(
      <FilterPanel
        metadata={renamedMetadata}
        model={{ filters: [], sort: [] }}
        values={new Map()}
        activeColumn="city"
        onApply={onApply}
        onRequestValues={onRequestValues}
      />
    );
    await waitFor(() => {
      for (const select of screen.getAllByLabelText("Column")) {
        expect(select).toHaveValue("c:1");
        expect(select).toHaveDisplayValue("revenue");
      }
    });
    expect(sortDisclosure).toHaveAttribute("open");

    fireEvent.click(screen.getByRole("button", { name: "Values" }));
    expect(onRequestValues).toHaveBeenLastCalledWith("revenue", "");
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply sort order" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sort: [expect.objectContaining({ column: "revenue", direction: "desc" })]
      })
    );
  });
});

describe("SummaryPanel", () => {
  const summaries: ColumnSummary[] = [
    {
      columnId: "c:1",
      column: "sales",
      type: "float",
      rawType: "float",
      totalCount: 4,
      nullCount: 1,
      nanCount: 2,
      distinctCount: 2,
      topValues: [
        { value: "12", count: 2 },
        { value: "10", count: 1 }
      ],
      numeric: { min: 10, max: 12, mean: Number.NaN, median: 12 }
    }
  ];

  it("renders loading, empty, missing, numeric, and top-value summaries", () => {
    const { rerender } = render(<SummaryPanel metadata={undefined} summaries={[]} schemaById={new Map()} />);
    expect(screen.getByText("Loading")).toBeInTheDocument();
    expect(screen.getByText("Profiling exact missing values…")).toBeInTheDocument();
    expect(screen.getByText("No summary data yet.")).toBeInTheDocument();

    rerender(
      <SummaryPanel
        metadata={metadata}
        summaries={summaries}
        schemaById={new Map(metadata.schema.map((column) => [column.id, column]))}
      />
    );
    expect(screen.getByText("4 rows x 2 columns")).toBeInTheDocument();
    expect(screen.getByText("Float64")).toBeInTheDocument();
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sales")).toHaveLength(2);
    expect(screen.getByText("Missing", { selector: "dt" }).nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("12", { selector: ".topValues span" })).toBeInTheDocument();
  });

  it("renders out-of-order duplicate-label summaries in schema order with human disambiguation", () => {
    const duplicateMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 },
      schema: [
        { id: "c:left", name: "value", position: 0, rawType: "Int64", type: "integer", nullable: false },
        { id: "c:right", name: "value", position: 1, rawType: "Float64", type: "float", nullable: false }
      ]
    };
    const summary = (columnId: string, rawType: string, min: number): ColumnSummary => ({
      columnId,
      column: "value",
      type: rawType === "Int64" ? "integer" : "float",
      rawType,
      totalCount: 4,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 4,
      numeric: { min, max: min + 3 },
      topValues: []
    });
    render(
      <SummaryPanel
        metadata={duplicateMetadata}
        summaries={[summary("c:right", "Float64", 10), summary("c:left", "Int64", 1)]}
        schemaById={new Map(duplicateMetadata.schema.map((column) => [column.id, column]))}
      />
    );

    expect(screen.getAllByText(/value \(column [12]\)/u).map((node) => node.textContent)).toEqual([
      "value (column 1)",
      "value (column 2)"
    ]);
    const groups = [...document.querySelectorAll<HTMLDetailsElement>(".summaryPanel .summaryGroup")].slice(1);
    expect(within(groups[0]!).getByText("Min").nextElementSibling).toHaveTextContent("1");
    expect(within(groups[1]!).getByText("Min").nextElementSibling).toHaveTextContent("10");
  });

  it("keeps an opened summary expanded as progressive results arrive", () => {
    const schema = Array.from({ length: 8 }, (_, position) => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "Int64",
      type: "integer" as const,
      nullable: false
    }));
    const progressiveMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: schema.length },
      filteredShape: { rows: 4, columns: schema.length },
      schema
    };
    const summary = (position: number): ColumnSummary => ({
      columnId: `c:${position}`,
      column: `column_${position}`,
      type: "integer",
      rawType: "Int64",
      totalCount: 4,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 4,
      numeric: { min: position, max: position + 3 },
      topValues: []
    });
    const schemaById = new Map(schema.map((column) => [column.id, column]));
    const { rerender } = render(
      <SummaryPanel
        metadata={progressiveMetadata}
        summaries={Array.from({ length: 7 }, (_, position) => summary(position))}
        schemaById={schemaById}
      />
    );
    const target = screen.getByText("column_3").closest("details");
    if (!(target instanceof HTMLDetailsElement)) throw new Error("Expected a column summary disclosure.");
    expect(target).not.toHaveAttribute("open");

    target.open = true;
    fireEvent(target, new Event("toggle"));
    expect(target).toHaveAttribute("open");

    rerender(
      <SummaryPanel
        metadata={progressiveMetadata}
        summaries={Array.from({ length: 8 }, (_, position) => summary(position))}
        schemaById={schemaById}
      />
    );
    expect(screen.getByText("column_3").closest("details")).toHaveAttribute("open");
  });

  it("promotes and expands the selected numeric column with exact statistics", () => {
    render(
      <SummaryPanel
        metadata={metadata}
        summaries={summaries}
        schemaById={new Map(metadata.schema.map((column) => [column.id, column]))}
        selectedColumnId="c:1"
      />
    );

    const summariesRoot = screen.getByRole("heading", { name: "Column Summary" }).parentElement;
    const selected = summariesRoot?.querySelector<HTMLDetailsElement>(".selectedSummary");
    expect(selected).toHaveAttribute("open");
    expect(selected?.querySelector("summary")).toHaveAttribute("aria-current", "true");
    expect(within(selected!).getByText("Selected · Float64")).toBeInTheDocument();
    expect(within(selected!).getByText("Min").nextElementSibling).toHaveTextContent("10");
    expect(within(selected!).getByText("Max").nextElementSibling).toHaveTextContent("12");
    expect(within(selected!).getByText("Median").nextElementSibling).toHaveTextContent("12");
  });
});
