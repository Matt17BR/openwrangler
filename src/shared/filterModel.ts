import type { ColumnFilter, ColumnType, FilterModel, PredicateFilter } from "./protocol.generated";

export type { ColumnFilter, ColumnType, FilterModel, PredicateFilter };
export type SortRule = FilterModel["sort"][number];
export type SortDirection = SortRule["direction"];
export type PredicateOperator = PredicateFilter["operator"];
export type ValueFilter = NonNullable<ColumnFilter["valueFilter"]>;

export const emptyFilterModel = (): FilterModel => ({
  filters: [],
  sort: []
});

export const hasActiveFilters = (model: FilterModel): boolean =>
  model.filters.some(
    (filter) =>
      filter.predicates.length > 0 ||
      (filter.valueFilter !== undefined &&
        (filter.valueFilter.selectedValues.length > 0 ||
          filter.valueFilter.includeNulls ||
          filter.valueFilter.includeNaN))
  );

export const hasActiveSort = (model: FilterModel): boolean => model.sort.length > 0;
