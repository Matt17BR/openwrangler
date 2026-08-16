import type { DataDiff, TransformStep } from "../shared/protocol";

export function draftDiffLabels(diff: DataDiff, displayedRowCount: number): string[] {
  const labels: string[] = [];
  if (diff.addedRows > 0) labels.push(`+${diff.addedRows.toLocaleString()} ${pluralize(diff.addedRows, "row")}`);
  if (diff.removedRows > 0) labels.push(`-${diff.removedRows.toLocaleString()} ${pluralize(diff.removedRows, "row")}`);
  if (diff.addedColumns.length > 0) {
    labels.push(`+${diff.addedColumns.length.toLocaleString()} ${pluralize(diff.addedColumns.length, "column")}`);
  }
  if (diff.removedColumns.length > 0) {
    labels.push(`-${diff.removedColumns.length.toLocaleString()} ${pluralize(diff.removedColumns.length, "column")}`);
  }
  if (diff.changedCells > 0) {
    labels.push(
      `${diff.changedCells.toLocaleString()} existing ${pluralize(diff.changedCells, "cell")} changed${
        diff.truncated ? " in this block" : ""
      }`
    );
  }
  const addedValues = displayedRowCount * diff.addedColumns.length;
  if (addedValues > 0) {
    labels.push(`${addedValues.toLocaleString()} ${pluralize(addedValues, "value")} added in this block`);
  }
  if (labels.length === 0) labels.push("No value changes in this block");
  return labels;
}

export function fillMissingResultLabel(remaining: number, step: TransformStep): string {
  if (step.kind !== "fillMissingValues") return "";
  const column = step.params.column.name;
  return remaining === 0
    ? `No missing values remain in ${column}`
    : `${remaining.toLocaleString()} missing ${pluralize(remaining, "value")} ${
        remaining === 1 ? "remains" : "remain"
      } in ${column}`;
}

function pluralize(value: number, singular: string): string {
  return value === 1 ? singular : `${singular}s`;
}
