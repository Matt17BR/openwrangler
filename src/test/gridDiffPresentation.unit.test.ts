import { describe, expect, it } from "vitest";
import type { CellValue, ColumnSchema, DataDiff, GridPage } from "../shared/protocol";
import { createGridDiffPresentation } from "../webviews/grid/gridDiffPresentation";

const emptyDiff: DataDiff = {
  addedRows: 0,
  removedRows: 0,
  addedColumns: [],
  removedColumns: [],
  changedCells: 0,
  cells: [],
  truncated: false
};

describe("grid diff presentation", () => {
  it("reconciles reordered rows and partial column projections through stable IDs", () => {
    const schema = [column("c:c", "c", 0), column("c:a", "a", 1), column("c:b", "b", 2)];
    const beforeSchema = [column("c:a", "a", 0), column("c:c", "c", 1), column("c:b", "b", 2)];
    const page = gridPage(
      ["c:c", "c:a"],
      [
        { id: "r:first", rowNumber: 0, values: [cell("same-c-first"), cell("new-a-first")] },
        { id: "r:second", rowNumber: 1, values: [cell("new-c-second"), cell("same-a-second")] }
      ]
    );
    const beforePage = gridPage(
      ["c:a", "c:c"],
      [
        { id: "r:second", rowNumber: 0, values: [cell("same-a-second"), cell("old-c-second")] },
        { id: "r:first", rowNumber: 1, values: [cell("old-a-first"), cell("same-c-first")] }
      ]
    );

    const presentation = createGridDiffPresentation(emptyDiff, page, schema, beforePage, beforeSchema);

    expect(presentation?.cell("r:first", "c:a")).toEqual({
      state: "changed",
      accessibilityLabel: "a, row 1: changed from old-a-first to new-a-first"
    });
    expect(presentation?.cell("r:second", "c:c")).toEqual({
      state: "changed",
      accessibilityLabel: "c, row 2: changed from old-c-second to new-c-second"
    });
    expect(presentation?.cell("r:first", "c:c")).toBeUndefined();
    expect(presentation?.cell("r:second", "c:a")).toBeUndefined();
    expect(presentation?.cell("r:first", "c:b")).toBeUndefined();
  });

  it("preserves duplicate-name cardinality while preferring newly introduced column IDs", () => {
    const schema = [
      column("c:kept", "value", 0),
      column("c:new-first", "value", 1),
      column("c:new-second", "value", 2)
    ];
    const beforeSchema = [
      column("c:kept", "value", 0),
      column("c:legacy-first", "legacy", 1, "Boolean"),
      column("c:legacy-second", "legacy", 2, "Integer")
    ];
    const diff: DataDiff = {
      ...emptyDiff,
      addedColumns: ["value", "value"],
      removedColumns: ["legacy", "legacy"]
    };
    const page = gridPage(
      ["c:kept", "c:new-first", "c:new-second"],
      [
        {
          id: "r:0",
          rowNumber: 0,
          values: [cell("kept"), cell("first"), cell("second")]
        }
      ]
    );

    const presentation = createGridDiffPresentation(diff, page, schema, undefined, beforeSchema);

    expect([...presentation!.addedColumnIds]).toEqual(["c:new-first", "c:new-second"]);
    expect(presentation?.addedColumns.map(({ name }) => name)).toEqual(["value", "value"]);
    expect(presentation?.removedColumns).toEqual([
      { name: "legacy", rawType: "Boolean" },
      { name: "legacy", rawType: "Boolean" }
    ]);
    expect(presentation?.cell("r:0", "c:kept")).toBeUndefined();
    expect(presentation?.cell("r:0", "c:new-first")?.state).toBe("added");
    expect(presentation?.cell("r:0", "c:new-second")?.state).toBe("added");
  });

  it("ignores off-page, unprojected, and stale protocol diffs while accepting the current after value", () => {
    const schema = [column("c:value", "value", 0), column("c:hidden", "hidden", 1)];
    const current = numberCell(10);
    const page = gridPage(["c:value"], [{ id: "r:10", rowNumber: 10, values: [current] }]);
    const diff: DataDiff = {
      ...emptyDiff,
      changedCells: 4,
      cells: [
        { rowNumber: 9, columnId: "c:value", column: "value", before: numberCell(1), after: numberCell(10) },
        { rowNumber: 10, columnId: "c:value", column: "value", before: numberCell(2), after: numberCell(9) },
        { rowNumber: 10, columnId: "c:hidden", column: "hidden", before: cell("old"), after: cell("new") },
        { rowNumber: 10, columnId: "c:value", column: "value", before: numberCell(8), after: numberCell(10) }
      ]
    };

    const presentation = createGridDiffPresentation(diff, page, schema, undefined, undefined);

    expect(presentation?.cell("r:10", "c:value")).toEqual({
      state: "changed",
      accessibilityLabel: "value, row 11: changed from 8 to 10"
    });
    expect(presentation?.cell("r:10", "c:hidden")).toBeUndefined();
    expect(presentation?.cell("r:9", "c:value")).toBeUndefined();
  });

  it("uses strict typed-cell equality for nested raw values and semantic flags", () => {
    const schema = [column("c:payload", "payload", 0)];
    const beforePage = gridPage(
      ["c:payload"],
      [
        {
          id: "r:equal",
          rowNumber: 0,
          values: [cell("nested", { alpha: [1, { left: true, right: null }], omega: "done" })]
        },
        { id: "r:nested-change", rowNumber: 1, values: [cell("nested", { values: [1, { deep: "old" }] })] },
        { id: "r:sign", rowNumber: 2, values: [numberCell(0, { sign: -1 })] },
        { id: "r:null", rowNumber: 3, values: [cell("same")] },
        { id: "r:nan", rowNumber: 4, values: [cell("same")] }
      ]
    );
    const page = gridPage(
      ["c:payload"],
      [
        {
          id: "r:equal",
          rowNumber: 0,
          values: [cell("nested", { omega: "done", alpha: [1, { right: null, left: true }] })]
        },
        { id: "r:nested-change", rowNumber: 1, values: [cell("nested", { values: [1, { deep: "new" }] })] },
        { id: "r:sign", rowNumber: 2, values: [numberCell(0, { sign: 1 })] },
        { id: "r:null", rowNumber: 3, values: [cell("same", "same", { isNull: true })] },
        { id: "r:nan", rowNumber: 4, values: [cell("same", "same", { isNaN: true })] }
      ]
    );

    const presentation = createGridDiffPresentation(emptyDiff, page, schema, beforePage, schema);

    expect(presentation?.cell("r:equal", "c:payload")).toBeUndefined();
    expect(presentation?.cell("r:nested-change", "c:payload")?.state).toBe("changed");
    expect(presentation?.cell("r:sign", "c:payload")?.state).toBe("changed");
    expect(presentation?.cell("r:null", "c:payload")?.state).toBe("changed");
    expect(presentation?.cell("r:nan", "c:payload")?.state).toBe("changed");
  });

  it("normalizes label whitespace and bounds value descriptions at 160 characters", () => {
    const normalizedLongValue = `${"x".repeat(80)} ${"y".repeat(80)}`;
    const exactValue = "z".repeat(160);
    const schema = [column("c:missing", "missing", 0), column("c:long", "long", 1), column("c:added", "added", 2)];
    const page = gridPage(
      ["c:missing", "c:long"],
      [
        {
          id: "r:0",
          rowNumber: 0,
          values: [cell("NaN", undefined, { kind: "nan", isNaN: true }), cell(`${"x".repeat(80)}\n\t${"y".repeat(80)}`)]
        },
        {
          id: "r:1",
          rowNumber: 1,
          values: [cell("present"), cell(exactValue)]
        }
      ]
    );
    const diff: DataDiff = {
      ...emptyDiff,
      addedColumns: ["added"],
      changedCells: 3,
      cells: [
        {
          rowNumber: 0,
          columnId: "c:missing",
          column: "missing",
          before: cell("null", undefined, { kind: "null", isNull: true }),
          after: page.rows[0]!.values[0]!
        },
        {
          rowNumber: 0,
          columnId: "c:long",
          column: "long",
          before: cell(""),
          after: page.rows[0]!.values[1]!
        },
        {
          rowNumber: 1,
          columnId: "c:long",
          column: "long",
          before: cell("", undefined, { kind: "unknown" }),
          after: page.rows[1]!.values[1]!
        }
      ]
    };

    const presentation = createGridDiffPresentation(diff, page, schema, undefined, undefined);

    expect(presentation?.cell("r:0", "c:missing")?.accessibilityLabel).toBe("missing, row 1: changed from null to NaN");
    expect(presentation?.cell("r:0", "c:long")?.accessibilityLabel).toBe(
      `long, row 1: changed from empty string to ${normalizedLongValue.slice(0, 159)}…`
    );
    expect(presentation?.cell("r:1", "c:long")?.accessibilityLabel).toBe(
      `long, row 2: changed from empty value to ${exactValue}`
    );
    expect(presentation?.cell("r:0", "c:added")).toEqual({
      state: "added",
      accessibilityLabel: "added, row 1: added column; before column absent; after no value"
    });
  });
});

function column(id: string, name: string, position: number, rawType = "String"): ColumnSchema {
  return { id, name, position, rawType, type: "string", nullable: false };
}

function cell(display: string, raw: unknown = display, overrides: Partial<CellValue> = {}): CellValue {
  return {
    kind: "string",
    raw,
    display,
    isNull: false,
    isNaN: false,
    ...overrides
  };
}

function numberCell(value: number, overrides: Partial<CellValue> = {}): CellValue {
  return cell(String(value), value, { kind: "number", ...overrides });
}

function gridPage(columnIds: string[], rows: GridPage["rows"]): GridPage {
  return {
    offset: rows[0]?.rowNumber ?? 0,
    limit: Math.max(rows.length, 1),
    totalRows: rows.reduce((total, row) => Math.max(total, row.rowNumber + 1), 0),
    columnIds,
    rows
  };
}
