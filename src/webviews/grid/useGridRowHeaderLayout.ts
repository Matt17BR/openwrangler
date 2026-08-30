import { useState } from "react";
import type { DataRow, RowAxis } from "../../shared/protocol";

const numericRowHeaderWidth = 58;
const maximumLabeledRowHeaderWidth = 180;
const rowLabelCharacterWidth = 8;
const rowLabelHorizontalPadding = 20;

interface GridRowHeaderLayoutState {
  sessionId: string;
  axisSignature: string;
  hasLabels: boolean;
  width: number;
}

interface GridRowHeaderLayout {
  rowAxisHeader: string | undefined;
  hasRowLabels: boolean;
  rowHeaderWidth: number;
}

/** Owns the sticky row-header gutter layout for one session and row axis. */
export function useGridRowHeaderLayout(
  sessionId: string,
  rowAxis: RowAxis | undefined,
  rows: readonly DataRow[]
): GridRowHeaderLayout {
  const rowAxisHeader = rowAxisHeaderLabel(rowAxis);
  const axisSignature = rowAxisSignature(rowAxis);
  const hasLabels = rows.some((row) => row.rowLabel !== undefined) || rowAxisHeader !== undefined;
  const nextWidth = rowHeaderWidthForRows(rows, rowAxisHeader);
  const [state, setState] = useState<GridRowHeaderLayoutState>({
    sessionId,
    axisSignature,
    hasLabels,
    width: nextWidth
  });

  let resolved = state;
  if (state.sessionId !== sessionId || state.axisSignature !== axisSignature) {
    resolved = { sessionId, axisSignature, hasLabels, width: nextWidth };
  } else if (hasLabels) {
    const width = Math.max(state.width, nextWidth);
    if (!state.hasLabels || width !== state.width) resolved = { ...state, hasLabels: true, width };
  }
  if (resolved !== state) setState(resolved);

  return {
    rowAxisHeader,
    hasRowLabels: resolved.hasLabels,
    rowHeaderWidth: resolved.width
  };
}

function rowAxisSignature(rowAxis: RowAxis | undefined): string {
  return rowAxis ? `${rowAxis.kind}:${rowAxis.levelNames.map((name) => name ?? "").join("\u0000")}` : "legacy";
}

function rowAxisHeaderLabel(rowAxis: RowAxis | undefined): string | undefined {
  if (!rowAxis || rowAxis.kind === "positional") return undefined;
  const names = rowAxis.levelNames.filter((name): name is string => name !== null && name.length > 0);
  if (rowAxis.kind === "index") return names[0] ?? "Index";
  return names.length > 0 ? names.join(" / ") : "Index";
}

function rowHeaderWidthForRows(rows: readonly DataRow[], header?: string): number {
  const longestLabel = rows.reduce(
    (longest, row) => Math.max(longest, row.rowLabel === undefined ? 0 : Array.from(row.rowLabel).length),
    header === undefined ? 0 : Array.from(header).length
  );
  if (longestLabel === 0) return numericRowHeaderWidth;
  return Math.min(
    maximumLabeledRowHeaderWidth,
    Math.max(numericRowHeaderWidth, longestLabel * rowLabelCharacterWidth + rowLabelHorizontalPadding)
  );
}
