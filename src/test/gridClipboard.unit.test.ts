import { describe, expect, it } from "vitest";
import type { ColumnSchema, GridPage } from "../shared/protocol";
import {
  buildGridClipboardPayload,
  collapsedGridClipboardSelection,
  extendGridClipboardSelection,
  gridClipboardSelectionContains,
  gridClipboardSelectionDescription
} from "../webviews/grid/gridClipboard";

const schema: ColumnSchema[] = [
  { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
  { id: "c:1", name: "note", position: 1, rawType: "String", type: "string", nullable: true }
];

const page: GridPage = {
  offset: 4,
  limit: 2,
  totalRows: 10,
  columnIds: ["c:0", "c:1"],
  rows: [
    {
      id: "r:4",
      rowNumber: 4,
      rowLabel: "account-5",
      values: [cell("Milan"), cell('contains\t"quote"')]
    },
    {
      id: "r:5",
      rowNumber: 5,
      values: [cell("Paris"), cell("two\nlines")]
    }
  ]
};

describe("grid clipboard contract", () => {
  it("normalizes an extended selection and describes its inclusive dimensions", () => {
    const selection = extendGridClipboardSelection(
      collapsedGridClipboardSelection("view-a", { row: 5, column: 1 }),
      "view-a",
      { row: 4, column: 0 }
    );

    expect(gridClipboardSelectionContains(selection, "view-a", { row: 4, column: 1 })).toBe(true);
    expect(gridClipboardSelectionContains(selection, "view-b", { row: 4, column: 1 })).toBe(false);
    expect(gridClipboardSelectionDescription(selection, "view-a")).toBe("2 rows by 2 columns selected");
  });

  it("copies the selected displayed values as spreadsheet-safe TSV", () => {
    const selection = {
      contextId: "view-a",
      anchor: { row: 4, column: 0 },
      focus: { row: 5, column: 1 }
    };

    expect(buildGridClipboardPayload({ mode: "range", selection, contextId: "view-a", schema, page })).toEqual({
      ok: true,
      payload: {
        text: 'Milan\t"contains\t""quote"""\nParis\t"two\nlines"',
        rowCount: 2,
        columnCount: 2,
        includesRowLabel: false,
        completeRow: true
      }
    });
  });

  it("copies the focused cell independently of the selection anchor", () => {
    const selection = {
      contextId: "view-a",
      anchor: { row: 4, column: 0 },
      focus: { row: 5, column: 1 }
    };

    expect(buildGridClipboardPayload({ mode: "cell", selection, contextId: "view-a", schema, page })).toEqual({
      ok: true,
      payload: { text: '"two\nlines"', rowCount: 1, columnCount: 1, includesRowLabel: false, completeRow: true }
    });
  });

  it("copies a complete loaded row and preserves its visible row label", () => {
    const selection = collapsedGridClipboardSelection("view-a", { row: 4, column: 1 });

    expect(buildGridClipboardPayload({ mode: "row", selection, contextId: "view-a", schema, page })).toEqual({
      ok: true,
      payload: {
        text: 'account-5\tMilan\t"contains\t""quote"""',
        rowCount: 1,
        columnCount: 2,
        includesRowLabel: true,
        completeRow: true
      }
    });
  });

  it("fails closed for stale views and limits row copy to the loaded projection", () => {
    const selection = collapsedGridClipboardSelection("view-a", { row: 4, column: 0 });
    expect(buildGridClipboardPayload({ mode: "cell", selection, contextId: "view-b", schema, page })).toEqual({
      ok: false,
      reason: "Select a cell in the current data view before copying."
    });
    expect(
      buildGridClipboardPayload({
        mode: "row",
        selection,
        contextId: "view-a",
        schema,
        page: { ...page, columnIds: ["c:0"], rows: page.rows.map((row) => ({ ...row, values: [row.values[0]] })) }
      })
    ).toEqual({
      ok: true,
      payload: {
        text: "account-5\tMilan",
        rowCount: 1,
        columnCount: 1,
        includesRowLabel: true,
        completeRow: false
      }
    });
  });

  it("rejects an unloaded row and a selection above the fixed cell bound", () => {
    const unloaded = collapsedGridClipboardSelection("view-a", { row: 3, column: 0 });
    expect(buildGridClipboardPayload({ mode: "cell", selection: unloaded, contextId: "view-a", schema, page })).toEqual(
      { ok: false, reason: "Wait for every selected row to load before copying." }
    );

    const wideSchema = Array.from({ length: 201 }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "String",
      type: "string",
      nullable: false
    }));
    const oversized = {
      contextId: "view-a",
      anchor: { row: 0, column: 0 },
      focus: { row: 500, column: 200 }
    };
    expect(
      buildGridClipboardPayload({ mode: "range", selection: oversized, contextId: "view-a", schema: wideSchema, page })
    ).toEqual({
      ok: false,
      reason: "Copy is limited to 100,000 cells. Select a smaller range."
    });
  });

  it("applies the text bound to UTF-8 bytes rather than JavaScript code units", () => {
    const selection = collapsedGridClipboardSelection("view-a", { row: 0, column: 0 });
    const oversizedUnicodePage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:0"],
      rows: [{ id: "r:0", rowNumber: 0, values: [cell("😀".repeat(1_048_577))] }]
    };

    expect(
      buildGridClipboardPayload({
        mode: "cell",
        selection,
        contextId: "view-a",
        schema: [schema[0]],
        page: oversizedUnicodePage
      })
    ).toEqual({ ok: false, reason: "Copy is limited to 4 MiB of displayed text. Select a smaller range." });
  });
});

function cell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}
