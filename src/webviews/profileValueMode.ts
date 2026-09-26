import type { ColumnSummary } from "../shared/protocol";

export type ProfileValueMode = "count" | "percent";

export function formatProfilePercent(value: number, denominator: number): string {
  if (denominator <= 0) return "0%";
  return new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(value / denominator);
}

export function formatProfileValue(value: number, denominator: number, mode: ProfileValueMode): string {
  return mode === "count" ? value.toLocaleString() : formatProfilePercent(value, denominator);
}

export function describeProfileValue(label: string, value: number, denominator: number): string {
  return `${label}: ${value.toLocaleString()} (${formatProfilePercent(value, denominator)})`;
}

export function profileDistributionDenominator(summary: ColumnSummary): number {
  return Math.max(0, summary.totalCount - summary.nullCount - summary.nanCount);
}
