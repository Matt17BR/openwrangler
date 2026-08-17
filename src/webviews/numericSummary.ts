import type { NumericSummary } from "../shared/protocol";

export function numericExtremumDisplay(
  summary: NumericSummary,
  bound: "min" | "max"
): { display: string; exact: boolean } | undefined {
  const exact = bound === "min" ? summary.exactMin : summary.exactMax;
  if (exact) return { display: exact.display, exact: true };
  const approximate = summary[bound];
  return approximate === undefined || !Number.isFinite(approximate)
    ? undefined
    : { display: formatNumericSummaryNumber(approximate), exact: false };
}

export function numericSumDisplay(summary: NumericSummary): { display: string; exact: boolean } | undefined {
  if (summary.exactSum) return { display: summary.exactSum.display, exact: true };
  return summary.sum === undefined || !Number.isFinite(summary.sum)
    ? undefined
    : { display: formatNumericSummaryNumber(summary.sum), exact: false };
}

export function formatNumericSummaryNumber(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
