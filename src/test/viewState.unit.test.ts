import { describe, expect, it } from "vitest";
import {
  decodeGridViewState,
  encodeGridViewState,
  MAX_GRID_COLUMN_ID_CODE_UNITS,
  MAX_GRID_COLUMN_WIDTH_ID_CODE_UNITS,
  MAX_GRID_COLUMN_WIDTHS,
  setGridColumnWidth
} from "../shared/viewState";
import { decodeWebviewMessage } from "../extension/webviewMessage";

const viewport = { firstVisibleRow: 3, scrollLeft: 17.5 };

describe("grid view state", () => {
  it("round-trips prototype-name and Unicode column IDs through the bounded tuple wire format", () => {
    const state = {
      columnWidths: new Map([
        ["__proto__", 120],
        ["constructor", 180],
        ["toString", 240],
        ["列😀", 320]
      ]),
      selectedColumnId: "列😀",
      viewport
    };

    const serialized = encodeGridViewState(state);

    expect(serialized).toEqual({
      columnWidths: [
        ["__proto__", 120],
        ["constructor", 180],
        ["toString", 240],
        ["列😀", 320]
      ],
      selectedColumnId: "列😀",
      viewport
    });
    const decoded = decodeGridViewState(serialized);
    expect(decoded?.columnWidths).toBeInstanceOf(Map);
    expect([...decoded!.columnWidths]).toEqual([...state.columnWidths]);
    expect(decoded).toMatchObject({ selectedColumnId: "列😀", viewport });
  });

  it("decodes renderer messages into prototype-safe state without accepting object-key aliases", () => {
    const context = { sessionId: "session", sessionRevision: 1, snapshot: undefined };
    const message = decodeWebviewMessage(
      {
        kind: "updateViewState",
        state: { columnWidths: [["__proto__", 160]], selectedColumnId: "__proto__", viewport }
      },
      context
    );

    expect(message?.kind).toBe("updateViewState");
    if (message?.kind === "updateViewState") {
      expect(message.state.columnWidths.get("__proto__")).toBe(160);
      expect(message.state.columnWidths.size).toBe(1);
    }
    expect(
      decodeWebviewMessage({ kind: "updateViewState", state: { columnWidths: { __proto__: 160 }, viewport } }, context)
    ).toBeUndefined();
  });

  it("rejects malformed, duplicate, over-count, and over-budget serialized widths", () => {
    const decode = (columnWidths: unknown, selectedColumnId?: unknown) =>
      decodeGridViewState({
        columnWidths,
        ...(selectedColumnId === undefined ? {} : { selectedColumnId }),
        viewport
      });

    expect(decode({ value: 120 })).toBeUndefined();
    expect(decode([["value"]])).toBeUndefined();
    expect(decode([["value", 120, "extra"]])).toBeUndefined();
    expect(
      decode([
        ["value", 120],
        ["value", 180]
      ])
    ).toBeUndefined();
    expect(decode([["", 120]])).toBeUndefined();
    expect(decode([["value", 79]])).toBeUndefined();
    expect(decode([["value", 641]])).toBeUndefined();
    expect(decode([["value", Number.NaN]])).toBeUndefined();
    expect(decode([], "")).toBeUndefined();
    expect(decode([], "x".repeat(MAX_GRID_COLUMN_ID_CODE_UNITS + 1))).toBeUndefined();
    expect(
      decode(Array.from({ length: MAX_GRID_COLUMN_WIDTHS + 1 }, (_, index) => [`c:${index}`, 120]))
    ).toBeUndefined();
    expect(
      decode(
        Array.from({ length: 17 }, (_, index) => [`${index}:${"x".repeat(MAX_GRID_COLUMN_ID_CODE_UNITS - 3)}`, 120])
      )
    ).toBeUndefined();
    expect(
      decodeGridViewState({
        columnWidths: [],
        viewport,
        unexpected: true
      })
    ).toBeUndefined();
  });

  it("keeps width updates immutable, bounded, and exact for prototype-name IDs", () => {
    const original = new Map<string, number>([["ordinary", 100]]);
    const updated = setGridColumnWidth(original, "__proto__", 220);

    expect(original.has("__proto__")).toBe(false);
    expect(updated.get("__proto__")).toBe(220);
    expect(updated.get("ordinary")).toBe(100);
    expect(setGridColumnWidth(updated, "bad", 700)).toBe(updated);

    const full = new Map(Array.from({ length: MAX_GRID_COLUMN_WIDTHS }, (_, index) => [`c:${index}`, 100] as const));
    const bounded = setGridColumnWidth(full, "列😀", 300);
    expect(bounded.size).toBe(MAX_GRID_COLUMN_WIDTHS);
    expect(bounded.has("c:0")).toBe(false);
    expect(bounded.get("列😀")).toBe(300);
  });

  it("refuses to encode states that exceed the count or aggregate ID budget", () => {
    const tooMany = new Map(
      Array.from({ length: MAX_GRID_COLUMN_WIDTHS + 1 }, (_, index) => [`c:${index}`, 100] as const)
    );
    expect(encodeGridViewState({ columnWidths: tooMany, viewport })).toBeUndefined();

    const overBudget = new Map<string, number>();
    const id = "x".repeat(MAX_GRID_COLUMN_ID_CODE_UNITS);
    const entryCount = Math.floor(MAX_GRID_COLUMN_WIDTH_ID_CODE_UNITS / id.length) + 1;
    for (let index = 0; index < entryCount; index += 1) overBudget.set(`${index}${id}`.slice(0, id.length), 100);
    expect(encodeGridViewState({ columnWidths: overBudget, viewport })).toBeUndefined();
  });
});
