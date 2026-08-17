import { describe, expect, it } from "vitest";
import type { ColumnSchema, ColumnSummary, FilterModel } from "../shared/protocol";
import {
  assertRColumnValuesContract,
  assertRDatasetStatsContract,
  assertRSummaryContract,
  requireRTransformColumn,
  resolveNamedRColumn,
  resolveRTransformFilterModel,
  resolveRTransformSortRules,
  resolveRViewQuery
} from "../extension/r/rKernelViewContract";

describe("R kernel view contract", () => {
  it("binds name-addressed views to immutable stable column identities", () => {
    const view = resolveRViewQuery(
      {
        logic: "or",
        filters: [
          {
            column: "value",
            type: "float",
            predicates: [{ kind: "predicate", operator: "gt", value: 1 }]
          }
        ],
        sort: [{ column: "group", direction: "asc", nulls: "last" }]
      },
      schema
    );

    expect(view).toEqual({
      logic: "or",
      filters: [
        {
          column: { id: "r:c:0", name: "value" },
          type: "float",
          predicates: [{ kind: "predicate", operator: "gt", value: 1 }]
        }
      ],
      sorts: [{ column: { id: "r:c:1", name: "group" }, direction: "asc", nulls: "last" }]
    });
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.filters)).toBe(true);
    expect(Object.isFrozen(view.filters[0]?.predicates)).toBe(true);
    expect(Object.isFrozen(view.sorts)).toBe(true);
  });

  it("fails closed on ambiguous names and declared-type drift", () => {
    const duplicateNames = [schema[0]!, { ...schema[1]!, name: "value" }];
    expect(() => resolveNamedRColumn("value", duplicateNames, "sort")).toThrow("ambiguous");

    const mismatched: FilterModel = {
      filters: [
        {
          column: "value",
          type: "string",
          predicates: [{ kind: "predicate", operator: "contains", value: "1" }]
        }
      ],
      sort: []
    };
    expect(() => resolveRViewQuery(mismatched, schema)).toThrow("declares string");
  });

  it("rejects private, duplicate, and type-incompatible transform references", () => {
    const privateColumn: ColumnSchema = {
      ...schema[0]!,
      id: "private",
      name: "__open_wrangler_internal_row_id_1"
    };
    expect(() =>
      requireRTransformColumn({ id: privateColumn.id, name: privateColumn.name }, [privateColumn], "Sort")
    ).toThrow("reserved private row-identity");

    const value = { id: "r:c:0", name: "value" };
    expect(() =>
      resolveRTransformSortRules(
        [
          { column: value, direction: "asc", nulls: "last" },
          { column: value, direction: "desc", nulls: "first" }
        ],
        schema,
        "Sort rows"
      )
    ).toThrow("repeats the same R column identity");

    expect(() =>
      resolveRTransformFilterModel(
        {
          filters: [
            {
              column: value,
              type: "float",
              predicates: [{ kind: "predicate", operator: "contains", value: "1" }]
            }
          ],
          sort: []
        },
        schema
      )
    ).toThrow("contains predicate is not available");
  });

  it("correlates typed value counts to the requested column and row domain", () => {
    const values = {
      column: "value",
      values: [
        {
          value: "2",
          count: 2,
          selectionValue: {
            kind: "typedSelection" as const,
            version: 1 as const,
            columnType: "float" as const,
            cell: { kind: "number" as const, raw: 2, display: "2", isNull: false, isNaN: false }
          }
        }
      ],
      hasMore: false
    };

    expect(() =>
      assertRColumnValuesContract(session, { id: "r:c:0", name: "value" }, values, 2, undefined)
    ).not.toThrow();
    expect(() =>
      assertRColumnValuesContract(
        session,
        { id: "r:c:0", name: "value" },
        { ...values, values: [{ ...values.values[0]!, count: 4 }] },
        2,
        undefined
      )
    ).toThrow("row counts");
    expect(() => assertRColumnValuesContract(session, { id: "r:c:1", name: "group" }, values, 2, undefined)).toThrow(
      "wrong column"
    );
  });

  it("checks summary and dataset-statistics results against one active view", () => {
    const view = resolveRViewQuery({ filters: [], sort: [] }, schema);
    const summary: ColumnSummary = {
      columnId: "r:c:0",
      column: "value",
      type: "float",
      rawType: "double",
      totalCount: 3,
      nullCount: 1,
      nanCount: 0,
      distinctCount: 2,
      topValues: [{ value: "2", count: 2 }]
    };
    const stats = {
      totalRows: 3,
      stats: {
        missingCells: 1,
        missingRows: 1,
        duplicateRows: 0,
        missingValuesByColumn: [
          { column: "value", count: 1 },
          { column: "group", count: 0 }
        ]
      }
    };

    expect(() => assertRSummaryContract(session, [{ id: "r:c:0", name: "value" }], [summary], view)).not.toThrow();
    expect(() => assertRDatasetStatsContract(session, stats, view)).not.toThrow();
    expect(() =>
      assertRSummaryContract(session, [{ id: "r:c:0", name: "value" }], [{ ...summary, totalCount: 2 }], view)
    ).toThrow("inconsistent filtered views");
    expect(() =>
      assertRDatasetStatsContract(session, { ...stats, stats: { ...stats.stats, missingCells: 2 } }, view)
    ).toThrow("inconsistent missing-value totals");
  });
});

const schema = Object.freeze([
  Object.freeze({
    id: "r:c:0",
    name: "value",
    position: 0,
    rawType: "double",
    type: "float" as const,
    nullable: true
  }),
  Object.freeze({
    id: "r:c:1",
    name: "group",
    position: 1,
    rawType: "character",
    type: "string" as const,
    nullable: false
  })
]);

const session = Object.freeze({ schema, rows: 3 });
