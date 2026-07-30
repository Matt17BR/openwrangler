import { describe, expect, it } from "vitest";
import {
  compactFilterModel,
  emptyFilterModel,
  hasActiveFilters,
  hasActiveSort,
  hasActiveViewQuery,
  prioritizeSortRule
} from "../shared/filterModel";
import { dataBackendLabel } from "../shared/protocol";

describe("filter model", () => {
  it("starts empty", () => {
    const model = emptyFilterModel();

    expect(hasActiveFilters(model)).toBe(false);
    expect(hasActiveSort(model)).toBe(false);
  });

  it("detects active value filters and sort rules", () => {
    const model = {
      filters: [
        {
          column: "city",
          type: "string" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: ["Milan"],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: [{ column: "sales", direction: "desc" as const, nulls: "last" as const }]
    };

    expect(hasActiveFilters(model)).toBe(true);
    expect(hasActiveSort(model)).toBe(true);
    expect(hasActiveViewQuery(model)).toBe(true);
  });

  it("compacts inactive value placeholders while preserving predicates and sorts", () => {
    const model = {
      logic: "or" as const,
      filters: [
        {
          column: "city",
          type: "string" as const,
          logic: "or" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: [],
            includeNulls: false,
            includeNaN: false,
            search: "search text is not a filter"
          },
          predicates: []
        },
        {
          column: "sales",
          type: "float" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: [],
            includeNulls: false,
            includeNaN: false
          },
          predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 10 }]
        }
      ],
      sort: [{ column: "city", direction: "asc" as const, nulls: "last" as const }]
    };

    expect(hasActiveFilters(model)).toBe(true);
    expect(compactFilterModel(model)).toEqual({
      logic: "or",
      filters: [
        {
          column: "sales",
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
        }
      ],
      sort: model.sort
    });
  });

  it("does not treat an empty selected-values placeholder as a query", () => {
    const model = {
      filters: [
        {
          column: "city",
          type: "string" as const,
          valueFilter: {
            kind: "values" as const,
            selectedValues: [],
            includeNulls: false,
            includeNaN: false
          },
          predicates: []
        }
      ],
      sort: []
    };

    expect(hasActiveFilters(model)).toBe(false);
    expect(hasActiveViewQuery(model)).toBe(false);
    expect(compactFilterModel(model).filters).toEqual([]);
  });

  it("makes the latest sort highest priority without duplicating its column", () => {
    const existing = [
      { column: "city", direction: "asc" as const, nulls: "last" as const },
      { column: "sales", direction: "desc" as const, nulls: "first" as const }
    ];

    expect(
      prioritizeSortRule(existing, {
        column: "sales",
        direction: "asc",
        nulls: "last"
      })
    ).toEqual([
      { column: "sales", direction: "asc", nulls: "last" },
      { column: "city", direction: "asc", nulls: "last" }
    ]);
    expect(existing).toEqual([
      { column: "city", direction: "asc", nulls: "last" },
      { column: "sales", direction: "desc", nulls: "first" }
    ]);
  });
});

describe("data backend labels", () => {
  it("uses the public PySpark spelling in editor UI", () => {
    expect(dataBackendLabel("pyspark")).toBe("PySpark");
  });
});
