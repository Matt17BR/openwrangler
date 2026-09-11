import { describe, expect, it } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import { isFilterModel } from "../shared/protocolValidation";
import {
  MAX_CONFIRMED_FILTER_HISTORY,
  confirmLatestFilterUndo,
  emptyConfirmedFilterHistory,
  latestConfirmedFilterUndo,
  recordConfirmedFilterTransition
} from "../webviews/filters/filterHistory";

const filterModel = (value: unknown, sort: FilterModel["sort"] = []): FilterModel => ({
  logic: "and",
  filters: [
    {
      column: "city",
      type: "string",
      predicates: [{ kind: "predicate", operator: "equals", value }]
    }
  ],
  sort
});

describe("confirmed viewing-filter history", () => {
  it("records changed confirmed filters but ignores sort-only confirmations", () => {
    const initial = { filters: [], sort: [] } satisfies FilterModel;
    const first = filterModel("Milan");
    const afterFirst = recordConfirmedFilterTransition(emptyConfirmedFilterHistory(), initial, first);

    expect(afterFirst.entries).toEqual([{ filters: [] }]);
    expect(
      recordConfirmedFilterTransition(
        afterFirst,
        first,
        filterModel("Milan", [{ column: "sales", direction: "desc", nulls: "last" }])
      )
    ).toBe(afterFirst);
  });

  it("keeps only the most recent bounded confirmed states", () => {
    let history = emptyConfirmedFilterHistory();
    let previous: FilterModel = { filters: [], sort: [] };
    for (let index = 0; index < MAX_CONFIRMED_FILTER_HISTORY + 4; index += 1) {
      const next = filterModel(String(index));
      history = recordConfirmedFilterTransition(history, previous, next);
      previous = next;
    }

    expect(history.entries).toHaveLength(MAX_CONFIRMED_FILTER_HISTORY);
    expect(history.entries[0]?.filters[0]?.predicates[0]?.value).toBe("3");
    expect(history.entries.at(-1)?.filters[0]?.predicates[0]?.value).toBe(String(MAX_CONFIRMED_FILTER_HISTORY + 2));
  });

  it("builds undo from confirmed filters, preserves current sorts, and consumes only a matching confirmation", () => {
    const initial = { logic: "or", filters: [], sort: [] } satisfies FilterModel;
    const current = filterModel("Paris", [{ column: "sales", direction: "asc", nulls: "first" }]);
    const history = recordConfirmedFilterTransition(emptyConfirmedFilterHistory(), initial, current);
    const undo = latestConfirmedFilterUndo(history, current);

    expect(undo).toEqual({
      target: { logic: "or", filters: [] },
      model: {
        logic: "or",
        filters: [],
        sort: [{ column: "sales", direction: "asc", nulls: "first" }]
      }
    });
    expect(confirmLatestFilterUndo(history, undo!.target, undo!.model).entries).toEqual([]);
    expect(confirmLatestFilterUndo(history, undo!.target, current).entries).toEqual([]);
  });

  it("does not consume history for a stale undo target", () => {
    const initial = { filters: [], sort: [] } satisfies FilterModel;
    const history = recordConfirmedFilterTransition(emptyConfirmedFilterHistory(), initial, filterModel("Paris"));
    const staleTarget = { filters: filterModel("Milan").filters };

    expect(confirmLatestFilterUndo(history, staleTarget, initial)).toBe(history);
  });

  it("preserves accepted JSON operands in independent history and undo copies", () => {
    const value = JSON.parse('[{"__proto__":{"marker":"kept"},"constructor":"literal"},-0]') as [
      { __proto__: { marker: string }; constructor: string },
      number
    ];
    const expected = JSON.stringify(value);
    const previous = filterModel(value);
    const current = filterModel("Paris", [{ column: "sales", direction: "desc", nulls: "last" }]);
    expect(isFilterModel(previous)).toBe(true);

    const history = recordConfirmedFilterTransition(emptyConfirmedFilterHistory(), previous, current);
    value[0].__proto__.marker = "original changed";
    const undo = latestConfirmedFilterUndo(history, current)!;
    const saved = history.entries[0]!.filters[0]!.predicates[0]!.value as typeof value;
    const target = undo.target.filters[0]!.predicates[0]!.value as typeof value;
    const request = undo.model.filters[0]!.predicates[0]!.value as typeof value;
    for (const copy of [saved, target, request]) {
      expect(Object.hasOwn(copy[0], "__proto__")).toBe(true);
      expect(Object.hasOwn(copy[0], "constructor")).toBe(true);
      expect(JSON.stringify(copy)).toBe(expected);
      expect(Object.is(copy[1], -0)).toBe(true);
    }
    expect(undo.model.sort).toBe(current.sort);

    request[0].__proto__.marker = "request changed";
    expect(target[0].__proto__.marker).toBe("kept");
    expect(saved[0].__proto__.marker).toBe("kept");
    target[0].constructor = "target changed";
    expect(request[0].constructor).toBe("literal");
    expect(saved[0].constructor).toBe("literal");
    saved[0].__proto__.marker = "history changed";
    expect(target[0].__proto__.marker).toBe("kept");
    expect(request[0].__proto__.marker).toBe("request changed");
    expect(value[0]).toEqual({ ["__proto__"]: { marker: "original changed" }, constructor: "literal" });
  });
});
