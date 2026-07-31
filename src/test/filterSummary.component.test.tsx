import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, SessionMetadata, TypedSelectionToken, ValuesResponse } from "../shared/protocol";
import { MAX_VIEW_VALUE_TEXT_CHARACTERS, MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS } from "../shared/viewValueLimits";
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

    fireEvent.change(screen.getByLabelText("Filter column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "between" } });
    expect(screen.getByPlaceholderText("Value")).toHaveAttribute(
      "maxLength",
      String(MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS)
    );
    expect(screen.getByPlaceholderText("And")).toHaveAttribute(
      "maxLength",
      String(MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS)
    );
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
    fireEvent.change(screen.getByLabelText("Sort null placement"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Prioritize sort" }));
    expect(screen.getByRole("list", { name: "Active sort order" })).toHaveTextContent("salesdescending");
    expect(screen.getByRole("list", { name: "Active sort order" })).toHaveTextContent("nulls first");

    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onApply).toHaveBeenLastCalledWith({ filters: [], sort: [] });
    fireEvent.click(screen.getByRole("button", { name: "Use basic filters" }));
    expect(screen.getByRole("button", { name: "Use advanced filters" })).toBeInTheDocument();
  });

  it("preserves exactly 65,536 predicate code points and truncates BMP or non-BMP overflow", () => {
    render(
      <FilterPanel
        metadata={metadata}
        model={{ filters: [], sort: [] }}
        values={values}
        onApply={() => undefined}
        onRequestValues={() => undefined}
      />
    );
    const input = screen.getByPlaceholderText("Value");
    const bmpAtLimit = "x".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);
    const astralAtLimit = "😀".repeat(MAX_VIEW_VALUE_TEXT_CHARACTERS);

    expect(input).toHaveAttribute("maxLength", String(MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS));
    fireEvent.change(input, { target: { value: `${bmpAtLimit}x` } });
    expect(input).toHaveValue(bmpAtLimit);
    fireEvent.change(input, { target: { value: astralAtLimit } });
    expect(input).toHaveValue(astralAtLimit);
    fireEvent.change(input, { target: { value: `${astralAtLimit}😀` } });
    expect(input).toHaveValue(astralAtLimit);

    fireEvent.change(screen.getByLabelText("Filter column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Predicate operator"), { target: { value: "between" } });
    const upperBound = screen.getByPlaceholderText("And");
    fireEvent.change(upperBound, { target: { value: `${astralAtLimit}😀` } });
    expect(upperBound).toHaveValue(astralAtLimit);
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
    expect(screen.getByText(/The newest sort becomes priority 1/u)).toBeVisible();

    fireEvent.change(screen.getByLabelText("Sort column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Sort null placement"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Prioritize sort" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("salesdescendingnulls first");
    expect(within(ordered).getAllByRole("listitem")[1]).toHaveTextContent("cityascending");
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard sort changes" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("cityascending");
    expect(within(ordered).getAllByRole("listitem")[1]).toHaveTextContent("salesdescendingnulls last");
    expect(screen.getByLabelText("Sort null placement")).toHaveValue("last");
    fireEvent.change(screen.getByLabelText("Sort null placement"), { target: { value: "first" } });
    fireEvent.click(screen.getByRole("button", { name: "Prioritize sort" }));

    fireEvent.click(screen.getByRole("button", { name: "Move sort 2, city, up one priority" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("cityascending");
    fireEvent.click(screen.getByRole("button", { name: "Move sort 2, sales, up one priority" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("salesdescendingnulls first");

    fireEvent.click(screen.getByRole("button", { name: "Change sort 1, sales, to ascending" }));
    fireEvent.click(screen.getByRole("button", { name: "Change sort 1, sales, to nulls last" }));
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("salesascendingnulls last");

    fireEvent.click(screen.getByRole("button", { name: "Remove sort 2, city, ascending, nulls last" }));
    expect(within(ordered).getAllByRole("listitem")).toHaveLength(1);
    expect(onApply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply sort order" }));
    expect(onApply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        logic: "or",
        filters: initialModel.filters,
        sort: [{ column: "sales", direction: "asc", nulls: "last" }]
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

  it("clears an uncommitted sort for the selected column without dropping sibling filters or sorts", () => {
    const siblingFilter = {
      column: "sales",
      type: "float" as const,
      predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 10 }]
    };
    const initialModel: FilterModel = {
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "i" }]
        },
        siblingFilter
      ],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
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

    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    const ordered = screen.getByRole("list", { name: "Active sort order" });
    expect(within(ordered).getAllByRole("listitem")[0]).toHaveTextContent("cityascending");
    expect(within(ordered).getAllByRole("listitem")[1]).toHaveTextContent("salesdescending");
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear column" }));
    expect(onApply).toHaveBeenLastCalledWith({
      filters: [siblingFilter],
      sort: [{ column: "sales", direction: "desc", nulls: "last" }]
    });
    expect(within(ordered).getAllByRole("listitem")).toHaveLength(1);
    expect(within(ordered).getByRole("listitem")).toHaveTextContent("salesdescending");
    expect(screen.getByRole("button", { name: "Apply sort order" })).toBeDisabled();
  });

  it("clears every uncommitted sort before applying the global clear", () => {
    const initialModel: FilterModel = {
      logic: "or",
      filters: [
        {
          column: "city",
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "i" }]
        }
      ],
      sort: []
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

    fireEvent.click(screen.getByText("SORTS"));
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    fireEvent.change(screen.getByLabelText("Sort column"), { target: { value: "c:1" } });
    fireEvent.change(screen.getByLabelText("Sort direction"), { target: { value: "desc" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to sort" }));
    expect(within(screen.getByRole("list", { name: "Active sort order" })).getAllByRole("listitem")).toHaveLength(2);
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onApply).toHaveBeenLastCalledWith({ filters: [], sort: [] });
    expect(screen.getByText("No active sorts.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply sort order" })).toBeDisabled();
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

    const columnSelect = screen.getByLabelText("Filter column");
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

    fireEvent.change(screen.getByLabelText("Filter column"), { target: { value: "c:1" } });
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

    fireEvent.change(screen.getByLabelText("Filter column"), { target: { value: "c:1" } });
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
    for (const select of screen.getAllByLabelText(/^(?:Filter|Sort) column$/u)) {
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
    for (const select of screen.getAllByLabelText(/^(?:Filter|Sort) column$/u)) {
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
    fireEvent.change(screen.getByLabelText("Filter column"), { target: { value: "c:1" } });
    for (const select of screen.getAllByLabelText(/^(?:Filter|Sort) column$/u)) {
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
      for (const select of screen.getAllByLabelText(/^(?:Filter|Sort) column$/u)) {
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
  const numericSummary: ColumnSummary = {
    columnId: "c:1",
    column: "sales",
    type: "float",
    rawType: "Float64",
    totalCount: 4,
    nullCount: 1,
    nanCount: 2,
    distinctCount: 2,
    topValues: [
      { value: "12", count: 2 },
      { value: "10", count: 1 }
    ],
    numeric: { min: 10, max: 12, mean: Number.NaN, median: 12 },
    visualization: {
      kind: "numeric",
      bins: [
        { min: 10, max: 11, count: 1 },
        { min: 11, max: 12, count: 2 }
      ],
      sampled: true
    }
  };

  const categoricalSummary: ColumnSummary = {
    columnId: "c:0",
    column: "city",
    type: "string",
    rawType: "String",
    totalCount: 4,
    nullCount: 0,
    nanCount: 0,
    distinctCount: 3,
    text: { emptyCount: 1, minLength: 0, maxLength: 6, meanLength: 3.25 },
    topValues: [
      { value: "Berlin", count: 2 },
      { value: "", count: 1 }
    ],
    visualization: {
      kind: "categorical",
      categories: [
        { value: "Berlin", count: 2 },
        { value: "", count: 1 }
      ],
      otherCount: 1
    }
  };

  const renderSummary = (
    options: {
      activeView?: "column" | "dataset" | "filters";
      selectedColumnId?: string;
      metadataValue?: SessionMetadata;
      summaries?: ColumnSummary[];
      onSelectView?: (view: "column" | "dataset" | "filters") => void;
    } = {}
  ) => {
    const metadataValue = options.metadataValue ?? metadata;
    return render(
      <SummaryPanel
        metadata={metadataValue}
        summaries={options.summaries ?? [categoricalSummary, numericSummary]}
        schemaById={new Map(metadataValue.schema.map((column) => [column.id, column]))}
        selectedColumnId={options.selectedColumnId}
        activeView={options.activeView ?? "column"}
        onSelectView={options.onSelectView ?? (() => undefined)}
      />
    );
  };

  it("exposes one keyboard-operable Column, Dataset, and Filters tablist", () => {
    const onSelectView = vi.fn();
    renderSummary({ activeView: "column", onSelectView });

    expect(screen.getByRole("tablist", { name: "Column profiles view" })).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Column", "Dataset", "Filters"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(tabs[0]!, { key: "ArrowRight" });
    expect(onSelectView).toHaveBeenLastCalledWith("dataset");
    expect(tabs[1]).toHaveFocus();
    fireEvent.keyDown(tabs[1]!, { key: "End" });
    expect(onSelectView).toHaveBeenLastCalledWith("filters");
    expect(tabs[2]).toHaveFocus();
  });

  it("renders only the selected column with exact scalar and sampled-distribution provenance", () => {
    renderSummary({ selectedColumnId: "c:1" });

    expect(screen.getByRole("tabpanel", { name: "Column" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "sales" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "city" })).not.toBeInTheDocument();
    expect(screen.getByText("Float64")).toBeInTheDocument();
    expect(screen.getByText("Exact statistics")).toBeInTheDocument();
    expect(screen.getByText("Sampled distribution")).toBeInTheDocument();
    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("NaN").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("10");
    expect(screen.getByText("Max").nextElementSibling).toHaveTextContent("12");
    expect(screen.getByText("Mean").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByRole("heading", { name: "Distribution" })).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Sampled numeric distribution with 2 bins; range 10 to 12." })
    ).toBeVisible();
    expect(screen.getAllByRole("graphics-symbol").map((bin) => bin.getAttribute("aria-label"))).toEqual([
      "10-11: 1 row",
      "11-12: 2 rows"
    ]);
    expect(screen.queryByRole("heading", { name: "Top values" })).not.toBeInTheDocument();
  });

  it("shows full typed extrema in Column profiles with exact titles and accessible names", () => {
    const minimum = "-12345678901234567890.123456789012345678";
    const maximum = "98765432109876543210.987654321098765432";
    const decimalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [
        {
          id: "c:amount",
          name: "amount",
          position: 0,
          rawType: "Decimal(38,18)",
          type: "decimal",
          nullable: false
        }
      ]
    };
    const decimalSummary: ColumnSummary = {
      columnId: "c:amount",
      column: "amount",
      type: "decimal",
      rawType: "Decimal(38,18)",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      numeric: {
        min: Number(minimum),
        max: Number(maximum),
        exactMin: { kind: "decimal", raw: minimum, display: minimum, isNull: false, isNaN: false },
        exactMax: { kind: "decimal", raw: maximum, display: maximum, isNull: false, isNaN: false }
      },
      visualization: {
        kind: "numeric",
        bins: [{ min: Number(minimum), max: Number(maximum), count: 2 }]
      },
      topValues: []
    };

    renderSummary({
      metadataValue: decimalMetadata,
      summaries: [decimalSummary],
      selectedColumnId: "c:amount"
    });

    const minimumValue = screen.getByText("Min").nextElementSibling;
    const maximumValue = screen.getByText("Max").nextElementSibling;
    expect(minimumValue).toHaveTextContent(minimum);
    expect(maximumValue).toHaveTextContent(maximum);
    expect(minimumValue).toHaveAttribute("title", `Minimum: ${minimum}`);
    expect(maximumValue).toHaveAttribute("title", `Maximum: ${maximum}`);
    expect(minimumValue).toHaveAccessibleName(`Minimum ${minimum}`);
    expect(maximumValue).toHaveAccessibleName(`Maximum ${maximum}`);
    expect(minimumValue).toHaveClass("exactNumericExtremum");
  });

  it("bounds protocol-maximum exact extrema visually while preserving their full accessible values", () => {
    const minimum = `-${"9".repeat(65_535)}`;
    const maximum = "9".repeat(65_536);
    const decimalMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 2, columns: 1 },
      filteredShape: { rows: 2, columns: 1 },
      schema: [
        {
          id: "c:amount",
          name: "amount",
          position: 0,
          rawType: "Decimal",
          type: "decimal",
          nullable: false
        }
      ]
    };
    const decimalSummary: ColumnSummary = {
      columnId: "c:amount",
      column: "amount",
      type: "decimal",
      rawType: "Decimal",
      totalCount: 2,
      nullCount: 0,
      nanCount: 0,
      distinctCount: 2,
      numeric: {
        exactMin: { kind: "decimal", raw: minimum, display: minimum, isNull: false, isNaN: false },
        exactMax: { kind: "decimal", raw: maximum, display: maximum, isNull: false, isNaN: false }
      },
      visualization: { kind: "numeric", bins: [] },
      topValues: []
    };

    renderSummary({
      metadataValue: decimalMetadata,
      summaries: [decimalSummary],
      selectedColumnId: "c:amount"
    });

    const minimumValue = screen.getByText("Min").nextElementSibling;
    const maximumValue = screen.getByText("Max").nextElementSibling;
    expect(minimumValue?.textContent).toHaveLength(96);
    expect(maximumValue?.textContent).toHaveLength(96);
    expect(minimumValue).toHaveTextContent("…");
    expect(maximumValue).toHaveTextContent("…");
    expect(minimumValue).toHaveAttribute("title", `Minimum: ${minimum}`);
    expect(maximumValue).toHaveAttribute("title", `Maximum: ${maximum}`);
    expect(minimumValue).toHaveAccessibleName(`Minimum ${minimum}`);
    expect(maximumValue).toHaveAccessibleName(`Maximum ${maximum}`);
  });

  it("falls back to the first schema column and labels categorical values and the remainder", () => {
    renderSummary();

    expect(screen.getByRole("heading", { name: "city" })).toBeInTheDocument();
    expect(screen.getByText("Exact distribution")).toBeInTheDocument();
    expect(screen.getByText("Distinct").nextElementSibling).toHaveTextContent("3");
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Min length").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Max length").nextElementSibling).toHaveTextContent("6");
    expect(screen.getByText("Mean length").nextElementSibling).toHaveTextContent("3.25");
    expect(screen.getByText("Other values").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByRole("heading", { name: "Top values" })).toBeInTheDocument();
    expect(screen.getByText("Berlin")).toBeInTheDocument();
    expect(screen.getByText("Empty string")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Berlin: 2" })).toHaveValue(2);
  });

  it("renders all-null text metrics without inventing length bounds", () => {
    renderSummary({
      summaries: [
        {
          ...categoricalSummary,
          totalCount: 4,
          nullCount: 4,
          distinctCount: 0,
          text: { emptyCount: 0 },
          topValues: [],
          visualization: { kind: "categorical", categories: [], otherCount: 0 }
        }
      ]
    });

    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("Min length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByText("Max length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.getByText("Mean length").nextElementSibling).toHaveTextContent("n/a");
    expect(screen.queryByText("NaN")).not.toBeInTheDocument();
  });

  it("keeps a nonzero Pandas NaN count visible for semantic text columns", () => {
    renderSummary({
      summaries: [
        {
          ...categoricalSummary,
          totalCount: 6,
          nanCount: 2
        }
      ]
    });

    expect(screen.getByText("Null").nextElementSibling).toHaveTextContent("0");
    expect(screen.getByText("NaN").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Empty").nextElementSibling).toHaveTextContent("1");
  });

  it("renders explicit datetime bounds and boolean counts from existing profile metadata", () => {
    const familyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 2 },
      filteredShape: { rows: 4, columns: 2 },
      schema: [
        { id: "c:flag", name: "flag", position: 0, rawType: "Boolean", type: "boolean", nullable: false },
        { id: "c:when", name: "when", position: 1, rawType: "Datetime", type: "datetime", nullable: true }
      ]
    };
    const familySummaries: ColumnSummary[] = [
      {
        columnId: "c:flag",
        column: "flag",
        type: "boolean",
        rawType: "Boolean",
        totalCount: 4,
        nullCount: 0,
        nanCount: 0,
        distinctCount: 2,
        topValues: [],
        visualization: { kind: "boolean", trueCount: 3, falseCount: 1 }
      },
      {
        columnId: "c:when",
        column: "when",
        type: "datetime",
        rawType: "Datetime",
        totalCount: 4,
        nullCount: 1,
        nanCount: 0,
        distinctCount: 3,
        topValues: [],
        visualization: { kind: "datetime", min: "2024-01-01", max: "2024-04-01" }
      }
    ];
    const { rerender } = renderSummary({
      metadataValue: familyMetadata,
      summaries: familySummaries,
      selectedColumnId: "c:flag"
    });
    expect(screen.getByText("True").nextElementSibling).toHaveTextContent("3");
    expect(screen.getByText("False").nextElementSibling).toHaveTextContent("1");

    rerender(
      <SummaryPanel
        metadata={familyMetadata}
        summaries={familySummaries}
        schemaById={new Map(familyMetadata.schema.map((column) => [column.id, column]))}
        selectedColumnId="c:when"
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("2024-01-01");
    expect(screen.getByText("Max").nextElementSibling).toHaveTextContent("2024-04-01");
  });

  it("renders dataset shape and exact missing and duplicate statistics only in Dataset view", () => {
    renderSummary({ activeView: "dataset" });

    expect(screen.getByRole("tabpanel", { name: "Dataset" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Dataset" })).toBeInTheDocument();
    expect(screen.getByText("Rows").nextElementSibling).toHaveTextContent("4");
    expect(screen.getByText("Columns").nextElementSibling).toHaveTextContent("2");
    expect(screen.getByText("Missing cells").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Rows with missing values").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("Duplicate rows").nextElementSibling).toHaveTextContent("1");
    expect(screen.getByText("sales")).toBeInTheDocument();
    expect(screen.queryByText("Profiling selected column...")).not.toBeInTheDocument();
  });

  it("renders bounded loading and empty states without implying missing profile data is exact", () => {
    const { rerender } = render(
      <SummaryPanel
        metadata={undefined}
        summaries={[]}
        schemaById={new Map()}
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Preparing column summary...")).toHaveAttribute("role", "status");

    const withoutStats = { ...metadata, stats: undefined };
    rerender(
      <SummaryPanel
        metadata={withoutStats}
        summaries={[]}
        schemaById={new Map(withoutStats.schema.map((column) => [column.id, column]))}
        selectedColumnId="c:1"
        activeView="dataset"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("Profiling exact dataset statistics...")).toHaveAttribute("role", "status");
    expect(screen.queryByText("Exact statistics")).not.toBeInTheDocument();

    const zeroColumnMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 0, columns: 0 },
      filteredShape: { rows: 0, columns: 0 },
      schema: []
    };
    rerender(
      <SummaryPanel
        metadata={zeroColumnMetadata}
        summaries={[]}
        schemaById={new Map()}
        activeView="column"
        onSelectView={() => undefined}
      />
    );
    expect(screen.getByText("This dataset has no columns.")).toBeInTheDocument();
  });

  it("renders only the selected duplicate label with positional disambiguation", () => {
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
    renderSummary({
      metadataValue: duplicateMetadata,
      summaries: [summary("c:right", "Float64", 10), summary("c:left", "Int64", 1)],
      selectedColumnId: "c:right"
    });

    expect(screen.getByRole("heading", { name: "value (column 2)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "value (column 1)" })).not.toBeInTheDocument();
    expect(screen.getByText("Min").nextElementSibling).toHaveTextContent("10");
  });

  it("renders only the shared tablist for the Filters view", () => {
    renderSummary({ activeView: "filters" });
    expect(screen.getByRole("tab", { name: "Filters" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tabpanel")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });
});
