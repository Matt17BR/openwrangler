import type {
  ColumnFilter,
  ColumnSchema,
  ColumnType,
  FilterModel,
  NumericBin,
  PredicateFilter
} from "./protocol.generated";

export type { ColumnFilter, ColumnType, FilterModel, PredicateFilter };
export type SortRule = FilterModel["sort"][number];
export type SortDirection = SortRule["direction"];
export type PredicateOperator = PredicateFilter["operator"];
export type ValueFilter = NonNullable<ColumnFilter["valueFilter"]>;

interface EffectiveValueFilter {
  selectedValues: readonly unknown[];
  includeNulls: boolean;
  includeNaN: boolean;
}

interface EffectiveColumnFilter {
  valueFilter?: EffectiveValueFilter;
  predicates: readonly unknown[];
}

interface EffectiveFilterModel {
  filters: readonly EffectiveColumnFilter[];
  sort: readonly unknown[];
}

const comparableColumnTypes: ReadonlySet<ColumnType> = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "duration"
]);

const nullPredicateOperators: readonly PredicateOperator[] = ["isNull", "isNotNull"];
const orderedPredicateOperators: readonly PredicateOperator[] = [
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  ...nullPredicateOperators
];
const predicateOperatorsByType: Readonly<Record<ColumnType, readonly PredicateOperator[]>> = {
  string: ["contains", "startsWith", "endsWith", ...orderedPredicateOperators],
  integer: orderedPredicateOperators,
  float: [...orderedPredicateOperators, "isNaN", "isNotNaN"],
  decimal: orderedPredicateOperators,
  boolean: ["equals", "notEquals", ...nullPredicateOperators],
  datetime: orderedPredicateOperators,
  date: orderedPredicateOperators,
  duration: orderedPredicateOperators,
  binary: nullPredicateOperators,
  list: nullPredicateOperators,
  struct: nullPredicateOperators,
  unknown: nullPredicateOperators
};

export const supportsTypedViewComparison = (type: ColumnType): boolean => comparableColumnTypes.has(type);

export const viewPredicateOperators = (type: ColumnType): readonly PredicateOperator[] =>
  predicateOperatorsByType[type];

export const supportsViewPredicate = (type: ColumnType, operator: PredicateOperator): boolean =>
  viewPredicateOperators(type).includes(operator);

export const countViewColumnNames = (columns: readonly Pick<ColumnSchema, "name">[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const column of columns) {
    counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  }
  return counts;
};

export const ambiguousViewColumnMessage = (name: string, count: number): string =>
  `View filters, sorts, and values are unavailable because ${count} columns share the displayed name ${JSON.stringify(name)}. Rename one column in a cleaning step first.`;

export const emptyFilterModel = (): FilterModel => ({
  logic: "and",
  filters: [],
  sort: []
});

export const isActiveColumnFilter = (filter: EffectiveColumnFilter): boolean =>
  filter.predicates.length > 0 ||
  (filter.valueFilter !== undefined &&
    (filter.valueFilter.selectedValues.length > 0 || filter.valueFilter.includeNulls || filter.valueFilter.includeNaN));

export const hasActiveFilters = (model: Pick<EffectiveFilterModel, "filters">): boolean =>
  model.filters.some(isActiveColumnFilter);

export const hasActiveSort = (model: Pick<EffectiveFilterModel, "sort">): boolean => model.sort.length > 0;

export const hasActiveViewQuery = (model: EffectiveFilterModel): boolean =>
  hasActiveFilters(model) || hasActiveSort(model);

export const prioritizeSortRule = (rules: readonly SortRule[], rule: SortRule): SortRule[] => [
  rule,
  ...rules.filter((candidate) => candidate.column !== rule.column)
];

export const viewSortModelSignature = (model: Pick<FilterModel, "sort">): string => JSON.stringify(model.sort);

export const compactColumnFilter = (filter: ColumnFilter): ColumnFilter | undefined => {
  const valueFilter =
    filter.valueFilter &&
    (filter.valueFilter.selectedValues.length > 0 || filter.valueFilter.includeNulls || filter.valueFilter.includeNaN)
      ? filter.valueFilter
      : undefined;
  if (filter.predicates.length === 0 && !valueFilter) return undefined;
  return {
    column: filter.column,
    type: filter.type,
    ...(filter.logic === undefined ? {} : { logic: filter.logic }),
    ...(valueFilter === undefined ? {} : { valueFilter }),
    predicates: filter.predicates
  };
};

export const compactFilterModel = (model: FilterModel): FilterModel => ({
  ...(model.logic === undefined ? {} : { logic: model.logic }),
  filters: model.filters.map(compactColumnFilter).filter((filter): filter is ColumnFilter => filter !== undefined),
  sort: model.sort
});

/**
 * Replace the active viewing filter for one displayed column while preserving
 * every other filter and the current sort order.
 */
export const replaceViewColumnFilter = (model: FilterModel, nextFilter: ColumnFilter): FilterModel => {
  const compactFilter = compactColumnFilter(nextFilter);
  let replaced = false;
  const filters = model.filters.flatMap((filter) => {
    if (filter.column !== nextFilter.column) return isActiveColumnFilter(filter) ? [filter] : [];
    if (replaced) return [];
    replaced = true;
    return compactFilter ? [compactFilter] : [];
  });
  if (!replaced && compactFilter) filters.push(compactFilter);
  return { ...model, filters };
};

/** Remove one displayed column's viewing filter without changing its sorts. */
export const removeViewColumnFilter = (model: FilterModel, column: string): FilterModel => ({
  ...model,
  filters: model.filters.filter((filter) => filter.column !== column && isActiveColumnFilter(filter))
});

export const viewValueSelectionFilter = (column: ColumnSchema, value: unknown): ColumnFilter => ({
  column: column.name,
  type: column.type,
  logic: "and",
  valueFilter: {
    kind: "values",
    selectedValues: [value],
    includeNulls: false,
    includeNaN: false
  },
  predicates: []
});

/**
 * Build a half-open histogram filter so adjacent bins never claim the same
 * boundary. Only the final bin includes its upper edge.
 */
export const viewNumericBinFilter = (column: ColumnSchema, bin: NumericBin, finalBin: boolean): ColumnFilter => ({
  column: column.name,
  type: column.type,
  logic: "and",
  predicates: [
    { kind: "predicate", operator: "gte", value: bin.min },
    { kind: "predicate", operator: finalBin ? "lte" : "lt", value: bin.max }
  ]
});
