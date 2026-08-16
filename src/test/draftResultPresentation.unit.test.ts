import { describe, expect, it } from "vitest";
import type { DataDiff, TransformStep } from "../shared/protocol";
import { draftDiffLabels, fillMissingResultLabel } from "../webviews/draftResultPresentation";

const emptyDiff: DataDiff = {
  addedRows: 0,
  removedRows: 0,
  addedColumns: [],
  removedColumns: [],
  changedCells: 0,
  cells: [],
  truncated: false
};

describe("draft result presentation", () => {
  it("describes every diff category and the values added to the displayed block", () => {
    expect(
      draftDiffLabels(
        {
          ...emptyDiff,
          addedRows: 1,
          removedRows: 2,
          addedColumns: ["new_a", "new_b"],
          removedColumns: ["old"],
          changedCells: 3,
          truncated: true
        },
        4
      )
    ).toEqual([
      "+1 row",
      "-2 rows",
      "+2 columns",
      "-1 column",
      "3 existing cells changed in this block",
      "8 values added in this block"
    ]);
  });

  it("reports an unchanged displayed block", () => {
    expect(draftDiffLabels(emptyDiff, 0)).toEqual(["No value changes in this block"]);
  });

  it.each([
    [0, "No missing values remain in amount"],
    [1, "1 missing value remains in amount"],
    [2_000, "2,000 missing values remain in amount"]
  ])("describes %i remaining fill targets", (remaining, expected) => {
    const step: TransformStep = {
      id: "fill-amount",
      kind: "fillMissingValues",
      params: { column: { id: "c:amount", name: "amount" }, replacement: { kind: "median" } }
    };
    expect(fillMissingResultLabel(remaining, step)).toBe(expected);
  });

  it("does not invent a missing-value label for another operation", () => {
    const step: TransformStep = {
      id: "rename-amount",
      kind: "renameColumn",
      params: { column: { id: "c:amount", name: "amount" }, newName: "total" }
    };
    expect(fillMissingResultLabel(1, step)).toBe("");
  });
});
