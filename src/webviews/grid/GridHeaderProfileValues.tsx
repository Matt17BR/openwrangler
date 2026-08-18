import type { ColumnSummary } from "../../shared/protocol";
import { numericExtremumDisplay } from "../numericSummary";
import { describeProfileValue, formatProfileValue, type ProfileValueMode } from "../profileValueMode";

export function HeaderProfileValue({
  label,
  value,
  denominator,
  mode
}: {
  label: string;
  value: number | undefined;
  denominator: number;
  mode: ProfileValueMode;
}) {
  if (value === undefined) {
    return (
      <span title={`${label} is unavailable`} aria-label={`${label} is unavailable`}>
        {label} n/a
      </span>
    );
  }
  const description = describeProfileValue(label, value, denominator);
  return (
    <span title={description} aria-label={description}>
      {label} {formatProfileValue(value, denominator, mode)}
    </span>
  );
}

export function CompactExtremum({
  label,
  summary,
  bound
}: {
  label: "Min" | "Max";
  summary: NonNullable<ColumnSummary["numeric"]>;
  bound: "min" | "max";
}) {
  const value = numericExtremumDisplay(summary, bound);
  if (!value) return null;
  const accessibleLabel = `${label === "Min" ? "Minimum" : "Maximum"} ${value.display}`;
  return (
    <span
      className={value.exact ? "exactNumericExtremum" : undefined}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {label} {value.display}
    </span>
  );
}
