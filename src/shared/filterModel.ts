import type {
  CellValue,
  ColumnFilter,
  ColumnSchema,
  ColumnType,
  FilterModel,
  NumericBin,
  PredicateFilter,
  TypedSelectionToken,
  ValueCount
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

const coercePredicateValue = (value: string, columnType: ColumnType): string | boolean => {
  if (columnType === "boolean") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return value;
  }
  // The runtime owns numeric syntax and binds against the native dtype.
  // A semantic float column may still contain exact integers in object storage.
  return value;
};

export const operatorRequiresValue = (operator: PredicateOperator): boolean =>
  !["isNull", "isNotNull", "isNaN", "isNotNaN"].includes(operator);

export const hasCompletePredicateValues = (operator: PredicateOperator, value: string, secondValue: string): boolean =>
  !operatorRequiresValue(operator) || (value !== "" && (operator !== "between" || secondValue !== ""));

export const createPredicate = (
  operator: PredicateOperator,
  value: string,
  secondValue: string,
  columnType: ColumnType
): PredicateFilter => {
  if (!operatorRequiresValue(operator)) {
    return { kind: "predicate", operator };
  }
  return {
    kind: "predicate",
    operator,
    value: coercePredicateValue(value, columnType),
    ...(operator === "between" ? { secondValue: coercePredicateValue(secondValue, columnType) } : {})
  };
};

export const countViewColumnNames = (columns: readonly Pick<ColumnSchema, "name">[]): ReadonlyMap<string, number> => {
  const counts = new Map<string, number>();
  for (const column of columns) {
    counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  }
  return counts;
};

export function reconcileViewFilterModel(
  model: FilterModel,
  previousSchema: readonly ColumnSchema[],
  nextSchema: readonly ColumnSchema[],
  policy: "id" | "name"
): FilterModel {
  const uniquePreviousByName = uniqueColumnsByName(previousSchema);
  const nextByKey = new Map(nextSchema.map((column) => [policy === "id" ? column.id : column.name, column]));
  const uniqueNextByName = uniqueColumnsByName(nextSchema);
  const filters = model.filters.flatMap((filter) => {
    const previous = uniquePreviousByName.get(filter.column);
    const next = previous ? nextByKey.get(policy === "id" ? previous.id : previous.name) : undefined;
    if (
      !previous ||
      (policy === "name" && previous.name.length === 0) ||
      !next ||
      uniqueNextByName.get(next.name)?.id !== next.id ||
      previous.type !== filter.type ||
      next.type !== filter.type
    ) {
      return [];
    }
    return [
      {
        ...filter,
        column: next.name,
        predicates: filter.predicates.map((predicate) => ({ ...predicate })),
        ...(filter.valueFilter
          ? { valueFilter: { ...filter.valueFilter, selectedValues: [...filter.valueFilter.selectedValues] } }
          : {})
      }
    ];
  });
  const sort = model.sort.flatMap((rule) => {
    const previous = uniquePreviousByName.get(rule.column);
    const next = previous ? nextByKey.get(policy === "id" ? previous.id : previous.name) : undefined;
    if (
      !previous ||
      (policy === "name" && previous.name.length === 0) ||
      !next ||
      uniqueNextByName.get(next.name)?.id !== next.id ||
      previous.type !== next.type ||
      (policy === "name" && !supportsTypedViewComparison(next.type))
    ) {
      return [];
    }
    return [{ ...rule, column: next.name }];
  });
  return {
    ...(model.logic ? { logic: model.logic } : {}),
    filters,
    sort
  };
}

function uniqueColumnsByName(schema: readonly ColumnSchema[]): Map<string, ColumnSchema> {
  const counts = countViewColumnNames(schema);
  return new Map(schema.filter((column) => counts.get(column.name) === 1).map((column) => [column.name, column]));
}

export const viewColumnNameUnavailableReason = (name: string, count: number): string | undefined => {
  if (name.length === 0) return "Viewing filters and sorts require a column name. Choose another column.";
  if (count > 1) {
    return `View filters, sorts, and values are unavailable because ${count} columns share the displayed name ${JSON.stringify(name)}. Rename one column in a cleaning step first.`;
  }
  return undefined;
};

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

export interface ViewFilterRemovalTarget {
  readonly column: string;
  readonly expectedSessionId: string;
  readonly expectedFilterSignature: string;
}

export const isViewFilterRemovalTarget = (value: unknown): value is ViewFilterRemovalTarget => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const target = value as Record<string, unknown>;
  const fields = ["column", "expectedSessionId", "expectedFilterSignature"];
  return (
    Object.keys(target).length === fields.length &&
    Object.keys(target).every((field) => fields.includes(field)) &&
    fields.every(
      (field) => Object.hasOwn(target, field) && typeof target[field] === "string" && target[field].length > 0
    )
  );
};

/** Clear removes the complete active same-name group, independently of other filters and sorts. */
export const viewFilterRemovalSignature = (filters: readonly ColumnFilter[], column: string): string | undefined => {
  const group = filters
    .filter((filter) => filter.column === column)
    .map(compactColumnFilter)
    .filter((filter): filter is ColumnFilter => filter !== undefined);
  return group.length > 0 ? JSON.stringify(group) : undefined;
};

/** Replace or remove only the exact viewing-filter entry that supplied an individual action. */
export const replaceViewFilterEntry = (
  model: FilterModel,
  targetEntry: ColumnFilter,
  nextEntry: ColumnFilter
): FilterModel => {
  const index = model.filters.indexOf(targetEntry);
  if (index < 0) return model;
  const compactEntry = compactColumnFilter(nextEntry);
  const filters = [...model.filters];
  if (compactEntry) filters[index] = compactEntry;
  else filters.splice(index, 1);
  return { ...model, filters };
};

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

export const valueSelectionUnavailableReason = "Exact selection is unavailable for this value.";

/** Omitted tokens retain raw compatibility; explicit null must never become a new raw selection. */
export const valueCountSelectionValue = (item: ValueCount): TypedSelectionToken | string | null =>
  item.selectionValue === undefined ? item.value : item.selectionValue;

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

export type ViewCellFilterAction = "include" | "exclude";

/**
 * Build a viewing filter from the typed value transported with a grid cell.
 * Display text is intentionally never used as value identity.
 */
export const viewCellSelectionFilter = (
  column: ColumnSchema,
  cell: CellValue,
  action: ViewCellFilterAction
): ColumnFilter => {
  if (cell.isNull) {
    return action === "include"
      ? {
          column: column.name,
          type: column.type,
          logic: "and",
          valueFilter: { kind: "values", selectedValues: [], includeNulls: true, includeNaN: false },
          predicates: []
        }
      : {
          column: column.name,
          type: column.type,
          logic: "and",
          predicates: [{ kind: "predicate", operator: "isNotNull" }]
        };
  }
  if (cell.isNaN) {
    return action === "include"
      ? {
          column: column.name,
          type: column.type,
          logic: "and",
          valueFilter: { kind: "values", selectedValues: [], includeNulls: false, includeNaN: true },
          predicates: []
        }
      : {
          column: column.name,
          type: column.type,
          logic: "and",
          predicates: [{ kind: "predicate", operator: "isNotNaN" }]
        };
  }

  const value: TypedSelectionToken = {
    kind: "typedSelection",
    version: 1,
    columnType: column.type,
    cell
  };
  return action === "include"
    ? viewValueSelectionFilter(column, value)
    : {
        column: column.name,
        type: column.type,
        logic: "and",
        predicates: [{ kind: "predicate", operator: "notEquals", value }]
      };
};

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
