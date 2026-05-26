import { describe, expect, it } from "vitest";
import { emptyFilterModel, hasActiveFilters, hasActiveSort } from "../shared/filterModel";

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
  });
});
