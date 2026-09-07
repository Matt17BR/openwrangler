import type { SessionMetadata, TypedSelectionToken } from "../../shared/protocol";
import type { ColumnFilter, PredicateFilter, PredicateOperator } from "../../shared/filterModel";

export const activeFilterValueChoiceCount = (filter: ColumnFilter): number =>
  (filter.valueFilter?.selectedValues.length ?? 0) +
  (filter.valueFilter?.includeNulls ? 1 : 0) +
  (filter.valueFilter?.includeNaN ? 1 : 0);

export const activeFilterConditionCount = (filter: ColumnFilter): number =>
  (activeFilterValueChoiceCount(filter) > 0 ? 1 : 0) + filter.predicates.length;

export const activeFilterColumnLabel = (name: string, metadata: SessionMetadata): string => {
  const display = name === "" ? "(empty name)" : name;
  const matches = metadata.schema.filter((column) => column.name === name);
  if (matches.length === 1) return display;
  if (matches.length > 1) return `${display} (ambiguous duplicate name)`;
  return `${display} (unavailable column)`;
};

const predicateLabels: Readonly<Record<PredicateOperator, string>> = {
  equals: "equals",
  notEquals: "does not equal",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  gt: "is greater than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  between: "is between",
  isNull: "is null",
  isNotNull: "is not null",
  isNaN: "is NaN",
  isNotNaN: "is not NaN"
};

export const predicateLabel = (predicate: PredicateFilter): string => {
  const operator = predicateLabels[predicate.operator];
  if (!predicateOperatorRequiresValue(predicate.operator)) return operator;
  const value = filterValueLabel(predicate.value);
  return predicate.operator === "between"
    ? `${operator} ${value} and ${filterValueLabel(predicate.secondValue)}`
    : `${operator} ${value}`;
};

export const filterValueLabel = (value: unknown): string => {
  if (isTypedSelectionToken(value)) {
    const display = value.cell.isNull
      ? "null"
      : value.cell.isNaN
        ? "NaN"
        : value.cell.kind === "string"
          ? quotedCompactText(value.cell.display)
          : compactText(value.cell.display);
    return `${display} (${value.cell.kind})`;
  }
  if (typeof value === "string") return quotedCompactText(value);
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN (number)";
    if (value === Number.POSITIVE_INFINITY) return "Infinity (number)";
    if (value === Number.NEGATIVE_INFINITY) return "-Infinity (number)";
    return `${String(value)} (number)`;
  }
  if (typeof value === "boolean") return `${String(value)} (boolean)`;
  if (value === undefined) return "(missing value)";
  try {
    return `${compactText(JSON.stringify(value))} (${Array.isArray(value) ? "array" : "object"})`;
  } catch {
    return "(unprintable value)";
  }
};

export const selectionValueKey = (value: unknown): string => {
  if (isTypedSelectionToken(value)) {
    const cell = value.cell;
    return JSON.stringify([
      value.kind,
      value.version,
      value.columnType,
      cell.kind,
      cell.sign ?? null,
      Object.prototype.hasOwnProperty.call(cell, "raw") ? cell.raw : ["display", cell.display]
    ]);
  }
  // Persisted filters can retain scalar selections from older runtimes.
  return `legacy:${String(value)}`;
};

export const matchesLegacySelection = (selected: unknown, candidate: unknown): boolean => {
  if (isTypedSelectionToken(selected) || !isTypedSelectionToken(candidate)) return false;
  const { cell, columnType } = candidate;
  // Mixed Pandas object columns are described as strings. Their numeric and
  // Boolean representatives must not inherit a legacy string's selection.
  if (columnType === "string") return cell.kind === "string" && selected === cell.raw;
  if (typeof selected !== "string") return selected === cell.raw && selected !== null;
  switch (columnType) {
    case "integer":
      return selected === String(cell.raw);
    case "float":
      if (cell.kind === "infinity") {
        return cell.sign === -1
          ? selected === "-Infinity" || selected === "-inf"
          : selected === "Infinity" || selected === "inf";
      }
      return (
        /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(selected) &&
        Number.isFinite(Number(selected)) &&
        Number(selected) === cell.raw
      );
    case "boolean":
      return selected.toLowerCase() === String(cell.raw);
    case "datetime":
      return selected.replace(" ", "T") === cell.raw;
    case "duration":
      // Historical duration lists used the same native text retained here;
      // raw seconds cannot recover that text without a second duration parser.
      return selected === cell.raw || (cell.kind === "duration" && selected === cell.display);
    default:
      return selected === cell.raw;
  }
};

export const isTypedSelectionToken = (value: unknown): value is TypedSelectionToken => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<TypedSelectionToken>;
  return (
    candidate.kind === "typedSelection" &&
    candidate.version === 1 &&
    typeof candidate.columnType === "string" &&
    typeof candidate.cell === "object" &&
    candidate.cell !== null
  );
};

const predicateOperatorRequiresValue = (operator: PredicateOperator): boolean =>
  !["isNull", "isNotNull", "isNaN", "isNotNaN"].includes(operator);

const quotedCompactText = (value: string): string => compactText(JSON.stringify(value));

const compactText = (value: string): string => (value.length <= 48 ? value : `${value.slice(0, 45)}…`);
