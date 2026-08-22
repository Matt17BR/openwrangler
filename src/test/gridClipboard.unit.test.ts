import { afterEach, describe, expect, it, vi } from "vitest";
import type { ColumnSchema, GridPage } from "../shared/protocol";
import {
  buildGridClipboardPayload,
  collapsedGridClipboardSelection,
  createGridClipboardColumnAccumulator,
  extendGridClipboardSelection,
  gridClipboardSelectionContains,
  gridClipboardSelectionDescription,
  tryAcquireGridClipboardWrite,
  writeGridClipboardText
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains one shared write owner until its noncancellable adapter settles", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const unsettledWrite = deferred<void>();
    const writeText = vi.fn(() => unsettledWrite.promise);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      const owner = tryAcquireGridClipboardWrite();
      expect(owner).toBeDefined();
      if (!owner) throw new Error("Expected the first clipboard write owner.");
      const write = owner.write("first payload", () => true);

      expect(tryAcquireGridClipboardWrite()).toBeUndefined();
      expect(() => owner.release()).toThrow("cannot be released before its write settles");
      expect(writeText).toHaveBeenCalledTimes(1);

      unsettledWrite.resolve();
      await write;
      owner.release();
      const replacement = tryAcquireGridClipboardWrite();
      expect(replacement).toBeDefined();
      replacement?.release();
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("does not enter fallback or restore stale focus after the exact owner changes", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    const primary = deferred<void>();
    const writeText = vi.fn(() => primary.promise);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    const owner = document.createElement("button");
    const replacement = document.createElement("button");
    document.body.append(owner, replacement);
    owner.focus();
    let current = true;

    try {
      const write = writeGridClipboardText("owned", (phase) => {
        return (
          current &&
          (document.activeElement === owner || ("helper" in phase && document.activeElement === phase.helper))
        );
      });
      replacement.focus();
      current = false;
      primary.reject(new Error("permission denied"));

      await expect(write).rejects.toThrow("Clipboard ownership changed");
      expect(execCommand).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(replacement);
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      owner.remove();
      replacement.remove();
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
      if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

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

  it.each([
    ["an equals sign", "=SUM(A1:A2)", "'=SUM(A1:A2)"],
    ["leading whitespace and a tab", " \t+cmd", '"\' \t+cmd"'],
    ["a leading control", "\u0000-42", "'\u0000-42"],
    ["a leading BOM", '\uFEFF@IMPORTDATA("url")', '"\'\uFEFF@IMPORTDATA(""url"")"']
  ])("neutralizes formula-like string cells after %s", (_label, display, expected) => {
    const selection = collapsedGridClipboardSelection("view-a", { row: 0, column: 0 });
    const formulaPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:0"],
      rows: [{ id: "r:0", rowNumber: 0, values: [cell(display)] }]
    };

    expect(
      buildGridClipboardPayload({
        mode: "cell",
        selection,
        contextId: "view-a",
        schema: [schema[0]],
        page: formulaPage
      })
    ).toEqual({
      ok: true,
      payload: {
        text: expected,
        rowCount: 1,
        columnCount: 1,
        includesRowLabel: false,
        completeRow: true
      }
    });
  });

  it("neutralizes formula-like row labels while retaining TSV quoting", () => {
    const selection = collapsedGridClipboardSelection("view-a", { row: 4, column: 1 });
    const formulaLabelPage: GridPage = {
      ...page,
      rows: [{ ...page.rows[0], rowLabel: "\t\uFEFF@ROW()" }, page.rows[1]]
    };

    expect(
      buildGridClipboardPayload({ mode: "row", selection, contextId: "view-a", schema, page: formulaLabelPage })
    ).toEqual({
      ok: true,
      payload: {
        text: '"\'\t\uFEFF@ROW()"\tMilan\t"contains\t""quote"""',
        rowCount: 1,
        columnCount: 2,
        includesRowLabel: true,
        completeRow: true
      }
    });
  });

  it("preserves typed numeric negatives while neutralizing the same displayed string", () => {
    const numericSchema = Array.from({ length: 4 }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "numeric",
      type: position === 0 ? "string" : "float",
      nullable: false
    }));
    const numericPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: numericSchema.map((column) => column.id),
      rows: [
        {
          id: "r:0",
          rowNumber: 0,
          values: [
            cell("-42"),
            { kind: "number", raw: -42, display: "-42", isNull: false, isNaN: false },
            { kind: "integer", raw: "-42", display: "-42", isNull: false, isNaN: false },
            { kind: "decimal", raw: "-42.5", display: "-42.5", isNull: false, isNaN: false }
          ]
        }
      ]
    };
    const selection = {
      contextId: "view-a",
      anchor: { row: 0, column: 0 },
      focus: { row: 0, column: 3 }
    };

    expect(
      buildGridClipboardPayload({
        mode: "range",
        selection,
        contextId: "view-a",
        schema: numericSchema,
        page: numericPage
      })
    ).toMatchObject({ ok: true, payload: { text: "'-42\t-42\t-42\t-42.5" } });
  });

  it("neutralizes hostile unknown displays in rectangular and whole-column copies", () => {
    const unknown = {
      kind: "unknown" as const,
      raw: { source: "opaque" },
      display: "=CMD()",
      isNull: false,
      isNaN: false
    };
    const selection = collapsedGridClipboardSelection("view-a", { row: 0, column: 0 });
    const unknownPage: GridPage = {
      offset: 0,
      limit: 1,
      totalRows: 1,
      columnIds: ["c:0"],
      rows: [{ id: "r:0", rowNumber: 0, values: [unknown] }]
    };

    expect(
      buildGridClipboardPayload({
        mode: "range",
        selection,
        contextId: "view-a",
        schema: [schema[0]],
        page: unknownPage
      })
    ).toMatchObject({ ok: true, payload: { text: "'=CMD()" } });

    const accumulator = createGridClipboardColumnAccumulator();
    expect(accumulator.append(unknown)).toBeUndefined();
    expect(accumulator.finish()).toMatchObject({ ok: true, payload: { text: "'=CMD()" } });
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

  it("enforces the exact UTF-8 cap across many fields without publishing a rejected payload", () => {
    const maximumBytes = 4 * 1024 * 1024;
    const columnCount = 4_096;
    const unicodeChunk = "😀".repeat(255);
    const boundarySchema = Array.from({ length: columnCount }, (_, position): ColumnSchema => ({
      id: `c:${position}`,
      name: `column_${position}`,
      position,
      rawType: "String",
      type: "string",
      nullable: false
    }));
    const selection = {
      contextId: "view-a",
      anchor: { row: 0, column: 0 },
      focus: { row: 0, column: columnCount - 1 }
    };
    const baseBytes = columnCount * 255 * 4 + columnCount - 1;
    const exactPadding = maximumBytes - baseBytes;

    for (const delta of [-1, 0, 1]) {
      const values = Array.from({ length: columnCount }, (_, index) =>
        cell(unicodeChunk + (index === columnCount - 1 ? "x".repeat(exactPadding + delta) : ""))
      );
      const boundaryPage: GridPage = {
        offset: 0,
        limit: 1,
        totalRows: 1,
        columnIds: boundarySchema.map((column) => column.id),
        rows: [{ id: "r:0", rowNumber: 0, values }]
      };
      const result = buildGridClipboardPayload({
        mode: "range",
        selection,
        contextId: "view-a",
        schema: boundarySchema,
        page: boundaryPage
      });

      if (delta <= 0) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(new TextEncoder().encode(result.payload.text).byteLength).toBe(maximumBytes + delta);
      } else {
        expect(result).toEqual({
          ok: false,
          reason: "Copy is limited to 4 MiB of displayed text. Select a smaller range."
        });
        expect(result).not.toHaveProperty("payload");
        expect(JSON.stringify(result)).not.toContain("😀");
      }
    }
  });

  it("accumulates a logical column with exact quoting, formula safety, and typed negatives", () => {
    const accumulator = createGridClipboardColumnAccumulator();
    expect(accumulator.append(cell(" \t+cmd"))).toBeUndefined();
    expect(accumulator.append(cell('contains\t"quote"'))).toBeUndefined();
    expect(
      accumulator.append({ kind: "decimal", raw: "-42.5", display: "-42.5", isNull: false, isNaN: false })
    ).toBeUndefined();

    expect(accumulator.finish()).toEqual({
      ok: true,
      payload: {
        text: '"\' \t+cmd"\n"contains\t""quote"""\n-42.5',
        rowCount: 3,
        columnCount: 1,
        includesRowLabel: false,
        completeRow: false
      }
    });
  });

  it("keeps empty, null, quoted, and Unicode values distinct without adding a header", () => {
    const accumulator = createGridClipboardColumnAccumulator();
    expect(accumulator.append(cell(""))).toBeUndefined();
    expect(accumulator.append({ kind: "null", raw: null, display: "", isNull: true, isNaN: false })).toBeUndefined();
    expect(accumulator.append(cell('München\t"Süd"'))).toBeUndefined();

    expect(accumulator.finish()).toEqual({
      ok: true,
      payload: {
        text: '\n\n"München\t""Süd"""',
        rowCount: 3,
        columnCount: 1,
        includesRowLabel: false,
        completeRow: false
      }
    });
  });

  it("enforces the exact UTF-8 cap incrementally across many logical-column pages", () => {
    const maximumBytes = 4 * 1024 * 1024;
    const fieldCount = 4_096;
    const unicodeChunk = "😀".repeat(255);
    const baseBytes = fieldCount * 255 * 4 + fieldCount - 1;
    const exactPadding = maximumBytes - baseBytes;

    for (const delta of [-1, 0, 1]) {
      const accumulator = createGridClipboardColumnAccumulator();
      let failure;
      for (let index = 0; index < fieldCount; index += 1) {
        failure = accumulator.append(
          cell(unicodeChunk + (index === fieldCount - 1 ? "x".repeat(exactPadding + delta) : ""))
        );
        if (failure) break;
      }
      if (delta <= 0) {
        expect(failure).toBeUndefined();
        const result = accumulator.finish();
        expect(result.ok).toBe(true);
        if (result.ok) expect(new TextEncoder().encode(result.payload.text).byteLength).toBe(maximumBytes + delta);
      } else {
        expect(failure).toEqual({
          ok: false,
          reason: "Copy is limited to 4 MiB of displayed text. Select a smaller range."
        });
        expect(failure).not.toHaveProperty("payload");
        expect(JSON.stringify(failure)).not.toContain("😀");
      }
    }
  });

  it("rejects a 100,001st logical-column cell without returning accumulated data", () => {
    const accumulator = createGridClipboardColumnAccumulator();
    for (let index = 0; index < 100_000; index += 1) expect(accumulator.append(cell("x"))).toBeUndefined();

    const rejection = accumulator.append(cell("hostile-payload"));
    expect(rejection).toEqual({
      ok: false,
      reason: "Copy is limited to 100,000 cells. Select a smaller range."
    });
    expect(rejection).not.toHaveProperty("payload");
    expect(JSON.stringify(rejection)).not.toContain("hostile-payload");
  });
});

function cell(display: string) {
  return { kind: "string" as const, raw: display, display, isNull: false, isNaN: false };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
