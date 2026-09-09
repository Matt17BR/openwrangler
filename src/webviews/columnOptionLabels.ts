import type { ColumnSchema } from "../shared/protocol";

export function columnOptionLabels(columns: readonly ColumnSchema[]): ReadonlyMap<string, string> {
  const nameCounts = new Map<string, number>();
  for (const column of columns) nameCounts.set(column.name, (nameCounts.get(column.name) ?? 0) + 1);

  const labels = new Map<string, string>();
  const occupiedLabels = new Set<string>();

  // Preserve every ordinary unique source name exactly. Positional labels are
  // then fitted around those names instead of making the common case verbose.
  for (const column of columns) {
    if (column.name === "" || nameCounts.get(column.name) !== 1) continue;
    labels.set(column.id, column.name);
    occupiedLabels.add(column.name);
  }

  for (const column of columns) {
    if (labels.has(column.id)) continue;
    const displayName = column.name === "" ? "(empty name)" : column.name;
    const humanPosition = column.position + 1;
    let label = `${displayName}, column ${humanPosition}`;
    if (occupiedLabels.has(label)) {
      const alternate = `${displayName}, source column ${humanPosition}`;
      label = alternate;
      let disambiguator = 2;
      while (occupiedLabels.has(label)) {
        label = `${alternate} (${disambiguator})`;
        disambiguator += 1;
      }
    }
    labels.set(column.id, label);
    occupiedLabels.add(label);
  }
  return labels;
}
