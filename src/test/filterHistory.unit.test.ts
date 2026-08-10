import { describe, expect, it } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import {
  MAX_CONFIRMED_FILTER_HISTORY,
  confirmLatestFilterUndo,
  emptyConfirmedFilterHistory,
  latestConfirmedFilterUndo,
  recordConfirmedFilterTransition
} from "../webviews/filters/filterHistory";

const filterModel = (value: string, sort: FilterModel["sort"] = []): FilterModel => ({
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
});
