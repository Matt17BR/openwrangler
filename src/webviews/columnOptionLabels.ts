import type { ColumnSchema } from "../shared/protocol";

export function columnOptionLabels(columns: readonly ColumnSchema[]): ReadonlyMap<string, string> {
  const nameCounts = new Map<string, number>();
  for (const column of columns) {
    const key = optionText(column.name);
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  const occupiedLabels = new Set<string>();

  // Preserve source names with unique option text. Positional labels are
  // then fitted around those names instead of making the common case verbose.
  for (const column of columns) {
    const key = optionText(column.name);
    if (key === "" || nameCounts.get(key) !== 1) continue;
    labels.set(column.id, column.name);
    occupiedLabels.add(key);
  }

  for (const column of columns) {
    if (labels.has(column.id)) continue;
    const displayName =
      column.name === "" ? "(empty name)" : optionText(column.name) === "" ? "(whitespace name)" : column.name;
    const humanPosition = column.position + 1;
    let label = `${displayName}, column ${humanPosition}`;
    if (occupiedLabels.has(optionText(label))) {
      const alternate = `${displayName}, source column ${humanPosition}`;
      label = alternate;
      let disambiguator = 2;
      while (occupiedLabels.has(optionText(label))) {
        label = `${alternate} (${disambiguator})`;
        disambiguator += 1;
      }
    }
    labels.set(column.id, label);
    occupiedLabels.add(optionText(label));
  }
  return labels;
}

// Native option text strips and collapses ASCII whitespace.
function optionText(text: string): string {
  return text.replace(/[\t\n\f\r ]+/gu, " ").replace(/^ | $/gu, "");
}
