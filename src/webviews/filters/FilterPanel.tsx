import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionMetadata, TypedSelectionToken, ValuesResponse } from "../../shared/protocol";
import type {
  ColumnFilter,
  ColumnType,
  FilterModel,
  PredicateFilter,
  PredicateOperator,
  SortDirection
} from "../../shared/filterModel";
import { MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS, truncateViewValueTextToCodePoints } from "../../shared/viewValueLimits";
import {
  ambiguousViewColumnMessage,
  countViewColumnNames,
  isActiveColumnFilter,
  prioritizeSortRule,
  removeViewColumnFilter,
  replaceViewColumnFilter,
  supportsTypedViewComparison,
  viewPredicateOperators
} from "../../shared/filterModel";

interface FilterPanelProps {
  metadata: SessionMetadata | undefined;
  model: FilterModel;
  values: ReadonlyMap<string, ValuesResponse>;
  activeColumn?: string;
  defaultAdvanced?: boolean;
  disabled?: boolean;
  filterSupported?: boolean;
  sortSupported?: boolean;
  columnValuesSupported?: boolean;
  onApply(model: FilterModel): void;
  onRequestValues(column: string, search?: string): void;
}

export function FilterPanel({
  metadata,
  model,
  values,
  activeColumn: requestedColumn,
  defaultAdvanced = false,
  disabled = false,
  filterSupported = true,
  sortSupported = true,
  columnValuesSupported = true,
  onApply,
  onRequestValues
}: FilterPanelProps) {
  const [columnId, setColumnId] = useState(
    () => metadata?.schema.find((item) => item.name === requestedColumn)?.id ?? metadata?.schema[0]?.id ?? ""
  );
  const previousRequestedColumn = useRef(requestedColumn);
  const [search, setSearch] = useState("");
  const [predicateOperator, setPredicateOperator] = useState<PredicateOperator>("contains");
  const [predicateValue, setPredicateValue] = useState("");
  const [secondPredicateValue, setSecondPredicateValue] = useState("");
  const modelSortKey = sortRulesKey(model.sort);
  const [sortInput, setSortInput] = useState<{
    modelKey: string;
    columnId: string;
    direction: SortDirection;
    nulls: "first" | "last";
  }>({ modelKey: modelSortKey, columnId: "", direction: "asc", nulls: "last" });
  const [sortEditor, setSortEditor] = useState(() => ({ modelKey: modelSortKey, rules: model.sort }));
  const draftSort = sortEditor.modelKey === modelSortKey ? sortEditor.rules : model.sort;
  const [sortOpen, setSortOpen] = useState(model.sort.length > 0);
  const [advanced, setAdvanced] = useState(defaultAdvanced);
  const viewColumnNameCounts = useMemo(() => countViewColumnNames(metadata?.schema ?? []), [metadata?.schema]);
  const activeFilters = model.filters.filter(isActiveColumnFilter);
  const panelLabel = filterSupported ? (sortSupported ? "Filters / Sorts" : "Filters") : "Sorts";

  useEffect(() => {
    const requestedColumnChanged = previousRequestedColumn.current !== requestedColumn;
    previousRequestedColumn.current = requestedColumn;
    setColumnId((currentId) => {
      const schema = metadata?.schema ?? [];
      const requestedSchema = schema.find((item) => item.name === requestedColumn);
      if (requestedColumnChanged && requestedSchema) return requestedSchema.id;
      if (schema.some((item) => item.id === currentId)) return currentId;
      return requestedSchema?.id ?? schema[0]?.id ?? "";
    });
  }, [metadata?.schema, requestedColumn]);

  const columnSchema = metadata?.schema.find((item) => item.id === columnId);
  const activeColumn = columnSchema?.name ?? "";
  const hasActiveColumn = Boolean(columnSchema && activeColumn);
  const activeColumnNameCount = viewColumnNameCounts.get(activeColumn) ?? 0;
  const activeColumnAmbiguous = activeColumnNameCount > 1;
  const activeSortRule = draftSort.find((rule) => rule.column === activeColumn);
  const activeSortInput =
    sortInput.modelKey === modelSortKey && sortInput.columnId === columnId ? sortInput : activeSortRule;
  const sortDirection = activeSortInput?.direction ?? "asc";
  const sortNulls = activeSortInput?.nulls ?? "last";

  const ambiguityMessage = activeColumnAmbiguous
    ? ambiguousViewColumnMessage(activeColumn, activeColumnNameCount)
    : undefined;
  const filterControlsDisabled = disabled || !filterSupported || activeColumnAmbiguous;
  const sortControlsDisabled = disabled || !sortSupported || activeColumnAmbiguous;
  const valueControlsDisabled = filterControlsDisabled || !columnValuesSupported;
  const supportsTypedComparison = columnSchema ? supportsTypedViewComparison(columnSchema.type) : false;
  const availableOperators = columnSchema ? viewPredicateOperators(columnSchema.type) : [];
  const activePredicateOperator = availableOperators.includes(predicateOperator)
    ? predicateOperator
    : (availableOperators[0] ?? "isNull");
  const columnValueResponse = activeColumn && !activeColumnAmbiguous ? values.get(activeColumn) : undefined;

  const activeFilter = activeFilters.find((item) => item.column === activeColumn);
  const selectedValues = new Map(
    (activeFilter?.valueFilter?.selectedValues ?? []).map((value) => [selectionValueKey(value), value])
  );

  if (!metadata) {
    return <section className="panel">Preparing filters...</section>;
  }

  const updateFilter = (nextFilter: ColumnFilter) => {
    if (disabled || !filterSupported || !nextFilter.column) return;
    onApply(replaceViewColumnFilter(model, nextFilter));
  };

  const removeColumnFilter = (column: string) => {
    if (disabled || !filterSupported) return;
    onApply(removeViewColumnFilter(model, column));
  };

  const removePredicate = (filter: ColumnFilter, index: number) => {
    if (disabled || !filterSupported) return;
    updateFilter({
      ...filter,
      predicates: filter.predicates.filter((_, candidateIndex) => candidateIndex !== index)
    });
  };

  const removeSelectedValue = (filter: ColumnFilter, value: unknown) => {
    if (disabled || !filterSupported || !filter.valueFilter) return;
    const key = selectionValueKey(value);
    updateFilter({
      ...filter,
      valueFilter: {
        ...filter.valueFilter,
        selectedValues: filter.valueFilter.selectedValues.filter((candidate) => selectionValueKey(candidate) !== key)
      }
    });
  };

  const removeValueFlag = (filter: ColumnFilter, flag: "includeNulls" | "includeNaN") => {
    if (disabled || !filterSupported || !filter.valueFilter) return;
    updateFilter({
      ...filter,
      valueFilter: {
        ...filter.valueFilter,
        [flag]: false
      }
    });
  };

  const toggleValue = (value: unknown) => {
    if (valueControlsDisabled || !columnSchema || !activeColumn || !supportsTypedComparison) {
      return;
    }
    const nextSelected = new Map(selectedValues);
    const key = selectionValueKey(value);
    if (nextSelected.has(key)) {
      nextSelected.delete(key);
    } else {
      nextSelected.set(key, value);
    }
    updateFilter({
      column: activeColumn,
      type: columnSchema.type,
      logic: activeFilter?.logic ?? "and",
      valueFilter: {
        kind: "values",
        selectedValues: [...nextSelected.values()],
        includeNulls: false,
        includeNaN: false,
        search
      },
      predicates: activeFilter?.predicates ?? []
    });
  };

  const addPredicate = () => {
    if (
      filterControlsDisabled ||
      !columnSchema ||
      !activeColumn ||
      !availableOperators.includes(activePredicateOperator) ||
      !hasCompletePredicateValues(activePredicateOperator, predicateValue, secondPredicateValue)
    ) {
      return;
    }
    const existing = activeFilter;
    const predicate = createPredicate(activePredicateOperator, predicateValue, secondPredicateValue, columnSchema.type);
    updateFilter({
      column: activeColumn,
      type: columnSchema.type,
      logic: existing?.logic ?? "and",
      valueFilter: existing?.valueFilter,
      predicates: [...(existing?.predicates ?? []), predicate]
    });
    setPredicateValue("");
    setSecondPredicateValue("");
  };

  const applySort = () => {
    if (sortControlsDisabled || !columnSchema || !activeColumn || !supportsTypedComparison) return;
    setSortEditor({
      modelKey: modelSortKey,
      rules: prioritizeSortRule(draftSort, {
        column: activeColumn,
        direction: sortDirection,
        nulls: sortNulls
      })
    });
  };

  const removeSort = (index: number) => {
    if (disabled || !sortSupported) return;
    setSortEditor({ modelKey: modelSortKey, rules: draftSort.filter((_, ruleIndex) => ruleIndex !== index) });
  };

  const toggleSortDirection = (index: number) => {
    if (disabled || !sortSupported) return;
    setSortEditor({
      modelKey: modelSortKey,
      rules: draftSort.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, direction: rule.direction === "asc" ? "desc" : "asc" } : rule
      )
    });
    const rule = draftSort[index];
    if (rule?.column === activeColumn) {
      setSortInput({
        modelKey: modelSortKey,
        columnId,
        direction: rule.direction === "asc" ? "desc" : "asc",
        nulls: rule.nulls
      });
    }
  };

  const toggleSortNulls = (index: number) => {
    if (disabled || !sortSupported) return;
    setSortEditor({
      modelKey: modelSortKey,
      rules: draftSort.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, nulls: rule.nulls === "first" ? "last" : "first" } : rule
      )
    });
    const rule = draftSort[index];
    if (rule?.column === activeColumn) {
      setSortInput({
        modelKey: modelSortKey,
        columnId,
        direction: rule.direction,
        nulls: rule.nulls === "first" ? "last" : "first"
      });
    }
  };

  const moveSort = (index: number, offset: -1 | 1) => {
    if (disabled || !sortSupported) return;
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= draftSort.length) return;
    const rules = [...draftSort];
    const current = rules[index];
    const adjacent = rules[nextIndex];
    if (!current || !adjacent) return;
    rules[index] = adjacent;
    rules[nextIndex] = current;
    setSortEditor({ modelKey: modelSortKey, rules });
  };
  const sortDirty = !sameSortRules(draftSort, model.sort);

  const clearColumn = () => {
    if (disabled || !filterSupported || !columnSchema || !activeColumn) return;
    const nextSort = sortSupported ? model.sort.filter((rule) => rule.column !== activeColumn) : model.sort;
    const nextSortKey = sortRulesKey(nextSort);
    setSortEditor({
      modelKey: nextSortKey,
      rules: draftSort.filter((rule) => rule.column !== activeColumn)
    });
    if (sortInput.columnId === columnId) {
      setSortInput({ modelKey: nextSortKey, columnId: "", direction: "asc", nulls: "last" });
    }
    onApply({
      ...model,
      filters: model.filters.filter((item) => item.column !== activeColumn),
      sort: nextSort
    });
  };

  const clearAll = () => {
    if (disabled || (!filterSupported && !sortSupported)) return;
    const nextSort: FilterModel["sort"] = sortSupported ? [] : model.sort;
    const nextSortKey = sortRulesKey(nextSort);
    setSortEditor({ modelKey: nextSortKey, rules: nextSort });
    setSortInput({ modelKey: nextSortKey, columnId: "", direction: "asc", nulls: "last" });
    onApply(
      filterSupported && sortSupported
        ? { filters: [], sort: [] }
        : {
            ...(model.logic === undefined ? {} : { logic: model.logic }),
            filters: filterSupported ? [] : model.filters,
            sort: nextSort
          }
    );
  };

  return (
    <section className="panel filterSortPanel" aria-busy={disabled}>
      <div className="panelHeader">
        <h2>{panelLabel}</h2>
        <button type="button" disabled={disabled || (!filterSupported && !sortSupported)} onClick={clearAll}>
          Clear all
        </button>
      </div>

      {filterSupported && (
        <ActiveFilterOverview
          filters={activeFilters}
          metadata={metadata}
          disabled={disabled}
          onRemoveColumn={removeColumnFilter}
          onRemovePredicate={removePredicate}
          onRemoveSelectedValue={removeSelectedValue}
          onRemoveValueFlag={removeValueFlag}
        />
      )}

      <details className="filterSection" open hidden={!filterSupported}>
        <summary>FILTERS</summary>
        <button
          type="button"
          className="secondaryButton"
          aria-expanded={advanced}
          disabled={disabled}
          onClick={() => setAdvanced((current) => !current)}
        >
          {advanced ? "Use basic filters" : "Use advanced filters"}
        </button>
        {advanced && (
          <label>
            Across columns
            <select
              value={model.logic ?? "and"}
              disabled={disabled}
              onChange={(event) => onApply({ ...model, logic: event.target.value as "and" | "or" })}
            >
              <option value="and">Match every filtered column</option>
              <option value="or">Match any filtered column</option>
            </select>
          </label>
        )}
        <label>
          Column
          <select
            aria-label="Filter column"
            value={columnId}
            disabled={disabled || !hasActiveColumn}
            onChange={(event) => setColumnId(event.target.value)}
          >
            {metadata.schema.length === 0 && <option value="">No columns available</option>}
            {metadata.schema.map((item) => (
              <option key={item.id} value={item.id}>
                {columnOptionLabel(item.name, item.position, viewColumnNameCounts)}
              </option>
            ))}
          </select>
        </label>
        {ambiguityMessage && (
          <p className="mutedText" role="status">
            {ambiguityMessage}
          </p>
        )}

        <div className="row">
          <input
            aria-label={`Search values for ${activeColumn || "selected column"}`}
            value={search}
            placeholder="Search values"
            disabled={valueControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (!valueControlsDisabled && supportsTypedComparison && event.key === "Enter" && activeColumn) {
                onRequestValues(activeColumn, search);
              }
            }}
          />
          <button
            type="button"
            className="searchValuesButton"
            aria-label={`Search values in ${activeColumn || "selected column"}`}
            disabled={valueControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onClick={() => {
              if (activeColumn) onRequestValues(activeColumn, search);
            }}
          >
            <span className="codicon codicon-search" aria-hidden="true" />
            Search
          </button>
        </div>

        <div className="valueList">
          {columnValueResponse?.sampleSize !== undefined && (
            <small className="mutedText" role="status">
              Counts shown are from a {columnValueResponse.sampleSize.toLocaleString()}-row sample. Exact search is
              subject to the engine&apos;s scan limit.
            </small>
          )}
          {(columnValueResponse?.values ?? []).map((item) => {
            const selectionValue = item.selectionValue ?? item.value;
            const selectionKey = selectionValueKey(selectionValue);
            return (
              <label key={selectionKey} className="checkboxRow">
                <input
                  type="checkbox"
                  checked={selectedValues.has(selectionKey)}
                  disabled={valueControlsDisabled || !supportsTypedComparison}
                  onChange={() => toggleValue(selectionValue)}
                />
                <span>{item.value}</span>
                <small>{item.count}</small>
              </label>
            );
          })}
          {columnValueResponse?.hasMore && (
            <small>
              {columnValueResponse.sampleSize === undefined
                ? "More values available. Refine the search to narrow results."
                : "More values may be available."}
            </small>
          )}
          {!columnValuesSupported && (
            <small className="mutedText" role="status">
              Value lists are unavailable. Use a predicate instead.
            </small>
          )}
        </div>

        <div className="predicateBuilder">
          {advanced && (
            <select
              aria-label="Condition combination"
              value={activeFilter?.logic ?? "and"}
              disabled={filterControlsDisabled || !hasActiveColumn}
              onChange={(event) => {
                if (!columnSchema || !activeColumn) return;
                const existing = activeFilter;
                if (!existing) return;
                updateFilter({
                  column: activeColumn,
                  type: columnSchema.type,
                  logic: event.target.value as "and" | "or",
                  valueFilter: existing?.valueFilter,
                  predicates: existing?.predicates ?? []
                });
              }}
            >
              <option value="and">All conditions</option>
              <option value="or">Any condition</option>
            </select>
          )}
          <select
            aria-label="Predicate operator"
            value={activePredicateOperator}
            disabled={filterControlsDisabled || !hasActiveColumn}
            onChange={(event) => setPredicateOperator(event.target.value as PredicateOperator)}
          >
            {availableOperators.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
          {operatorRequiresValue(activePredicateOperator) && (
            <input
              aria-label={`${activePredicateOperator} predicate value`}
              value={predicateValue}
              maxLength={MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS}
              placeholder="Value"
              disabled={filterControlsDisabled || !hasActiveColumn}
              onChange={(event) => setPredicateValue(truncateViewValueTextToCodePoints(event.target.value))}
            />
          )}
          {activePredicateOperator === "between" && (
            <input
              aria-label="Between predicate upper bound"
              value={secondPredicateValue}
              maxLength={MAX_VIEW_VALUE_TEXT_UTF16_CODE_UNITS}
              placeholder="And"
              disabled={filterControlsDisabled || !hasActiveColumn}
              onChange={(event) => setSecondPredicateValue(truncateViewValueTextToCodePoints(event.target.value))}
            />
          )}
          <button
            type="button"
            disabled={
              filterControlsDisabled ||
              !hasActiveColumn ||
              !availableOperators.includes(activePredicateOperator) ||
              !hasCompletePredicateValues(activePredicateOperator, predicateValue, secondPredicateValue)
            }
            onClick={addPredicate}
          >
            Add predicate
          </button>
        </div>

        {!supportsTypedComparison && hasActiveColumn && (
          <p className="mutedText" role="status">
            This complex column supports missing-value checks, but not value selection, comparison, or sorting.
          </p>
        )}

        <button type="button" disabled={disabled || !hasActiveColumn} onClick={clearColumn}>
          Clear column
        </button>
      </details>
      <details
        className="filterSection"
        open={sortOpen}
        hidden={!sortSupported}
        onToggle={(event) => setSortOpen(event.currentTarget.open)}
      >
        <summary>SORTS</summary>
        <label>
          Column
          <select
            aria-label="Sort column"
            value={columnId}
            disabled={disabled || !hasActiveColumn}
            onChange={(event) => setColumnId(event.target.value)}
          >
            {metadata.schema.length === 0 && <option value="">No columns available</option>}
            {metadata.schema.map((item) => (
              <option key={item.id} value={item.id}>
                {columnOptionLabel(item.name, item.position, viewColumnNameCounts)}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <select
            aria-label="Sort direction"
            value={sortDirection}
            disabled={sortControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onChange={(event) =>
              setSortInput({
                modelKey: modelSortKey,
                columnId,
                direction: event.target.value as SortDirection,
                nulls: sortNulls
              })
            }
          >
            <option value="asc">Sort ascending</option>
            <option value="desc">Sort descending</option>
          </select>
          <select
            aria-label="Sort null placement"
            value={sortNulls}
            disabled={sortControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onChange={(event) =>
              setSortInput({
                modelKey: modelSortKey,
                columnId,
                direction: sortDirection,
                nulls: event.target.value as "first" | "last"
              })
            }
          >
            <option value="last">Nulls last</option>
            <option value="first">Nulls first</option>
          </select>
          <button
            type="button"
            disabled={sortControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onClick={applySort}
          >
            {draftSort.some((rule) => rule.column === activeColumn) ? "Prioritize sort" : "Add to sort"}
          </button>
        </div>
        <p className="panelNote">
          The newest sort becomes priority 1. Use the arrow controls to change priority; changes stay local until you
          apply the sort order.
        </p>
        <div className="sortRulesHeader">
          <strong>Active sort order</strong>
          <button
            type="button"
            className="secondaryButton"
            disabled={disabled || draftSort.length === 0}
            onClick={() => setSortEditor({ modelKey: modelSortKey, rules: [] })}
          >
            Clear all sorts
          </button>
        </div>
        <div className="activeRules" aria-live="polite">
          {draftSort.length === 0 && <span className="mutedText">No active sorts.</span>}
          {draftSort.length > 0 && (
            <ol className="sortRuleList" aria-label="Active sort order">
              {draftSort.map((rule, index) => {
                const directionLabel = rule.direction === "asc" ? "ascending" : "descending";
                const nextDirectionLabel = rule.direction === "asc" ? "descending" : "ascending";
                const nullsLabel = rule.nulls === "first" ? "nulls first" : "nulls last";
                const nextNullsLabel = rule.nulls === "first" ? "nulls last" : "nulls first";
                return (
                  <li key={rule.column} className="sortRule">
                    <span className="sortRulePriority" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="sortRuleColumn">{rule.column}</span>
                    <div className="sortRuleControls">
                      <button
                        type="button"
                        className="iconButton codicon codicon-chevron-up"
                        disabled={disabled || index === 0}
                        aria-label={`Move sort ${index + 1}, ${rule.column}, up one priority`}
                        title="Move up"
                        onClick={() => moveSort(index, -1)}
                      />
                      <button
                        type="button"
                        className="iconButton codicon codicon-chevron-down"
                        disabled={disabled || index === draftSort.length - 1}
                        aria-label={`Move sort ${index + 1}, ${rule.column}, down one priority`}
                        title="Move down"
                        onClick={() => moveSort(index, 1)}
                      />
                      <button
                        type="button"
                        className="secondaryButton sortDirectionButton"
                        disabled={disabled}
                        aria-label={`Change sort ${index + 1}, ${rule.column}, to ${nextDirectionLabel}`}
                        onClick={() => toggleSortDirection(index)}
                      >
                        <span
                          className={`codicon ${rule.direction === "asc" ? "codicon-arrow-up" : "codicon-arrow-down"}`}
                          aria-hidden="true"
                        />
                        {directionLabel}
                      </button>
                      <button
                        type="button"
                        className="secondaryButton"
                        disabled={disabled}
                        aria-label={`Change sort ${index + 1}, ${rule.column}, to ${nextNullsLabel}`}
                        onClick={() => toggleSortNulls(index)}
                      >
                        {nullsLabel}
                      </button>
                      <button
                        type="button"
                        className="iconButton codicon codicon-close"
                        disabled={disabled}
                        aria-label={`Remove sort ${index + 1}, ${rule.column}, ${directionLabel}, ${nullsLabel}`}
                        title="Remove sort"
                        onClick={() => removeSort(index)}
                      />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        <div className="sortApplyActions">
          <button
            type="button"
            disabled={disabled || !sortDirty}
            onClick={() => onApply({ ...model, sort: draftSort })}
          >
            Apply sort order
          </button>
          <button
            type="button"
            className="secondaryButton"
            disabled={disabled || !sortDirty}
            onClick={() => {
              setSortEditor({ modelKey: modelSortKey, rules: model.sort });
              setSortInput({ modelKey: modelSortKey, columnId: "", direction: "asc", nulls: "last" });
            }}
          >
            Discard sort changes
          </button>
        </div>
      </details>
      {!sortSupported && (
        <p className="mutedText" role="status">
          Sorting is unavailable for this dataframe.
        </p>
      )}
    </section>
  );
}

const sameSortRules = (left: FilterModel["sort"], right: FilterModel["sort"]): boolean =>
  left.length === right.length &&
  left.every(
    (rule, index) =>
      rule.column === right[index]?.column &&
      rule.direction === right[index]?.direction &&
      rule.nulls === right[index]?.nulls
  );

const sortRulesKey = (rules: FilterModel["sort"]): string =>
  JSON.stringify(rules.map((rule) => [rule.column, rule.direction, rule.nulls]));

interface ActiveFilterOverviewProps {
  filters: ColumnFilter[];
  metadata: SessionMetadata;
  disabled: boolean;
  onRemoveColumn(column: string): void;
  onRemovePredicate(filter: ColumnFilter, index: number): void;
  onRemoveSelectedValue(filter: ColumnFilter, value: unknown): void;
  onRemoveValueFlag(filter: ColumnFilter, flag: "includeNulls" | "includeNaN"): void;
}

function ActiveFilterOverview({
  filters,
  metadata,
  disabled,
  onRemoveColumn,
  onRemovePredicate,
  onRemoveSelectedValue,
  onRemoveValueFlag
}: ActiveFilterOverviewProps) {
  return (
    <section className="activeFilterOverview" aria-label="Active filters">
      <header>
        <strong>Active filters</strong>
        <span className="mutedText">
          {filters.length} filtered {filters.length === 1 ? "column" : "columns"}
        </span>
      </header>
      {filters.length === 0 ? (
        <p className="mutedText">No active filters.</p>
      ) : (
        <div className="activeFilterList">
          {filters.map((filter) => {
            const columnLabel = activeFilterColumnLabel(filter.column, metadata);
            return (
              <section key={filter.column} className="activeFilterGroup" aria-label={`${columnLabel} filters`}>
                <header>
                  <span>
                    <strong>{columnLabel}</strong>
                    <small>{filter.logic === "or" ? "Match any" : "Match all"}</small>
                  </span>
                  <button
                    type="button"
                    className="compactTextButton"
                    disabled={disabled}
                    aria-label={`Clear filter for ${columnLabel}`}
                    onClick={() => onRemoveColumn(filter.column)}
                  >
                    Clear
                  </button>
                </header>
                <div className="activeRules">
                  {(filter.valueFilter?.selectedValues ?? []).map((value) => {
                    const summary = `equals ${filterValueLabel(value)}`;
                    return (
                      <FilterRuleButton
                        key={`value:${selectionValueKey(value)}`}
                        columnLabel={columnLabel}
                        summary={summary}
                        disabled={disabled}
                        onClick={() => onRemoveSelectedValue(filter, value)}
                      />
                    );
                  })}
                  {filter.valueFilter?.includeNulls && (
                    <FilterRuleButton
                      columnLabel={columnLabel}
                      summary="is null"
                      disabled={disabled}
                      onClick={() => onRemoveValueFlag(filter, "includeNulls")}
                    />
                  )}
                  {filter.valueFilter?.includeNaN && (
                    <FilterRuleButton
                      columnLabel={columnLabel}
                      summary="is NaN"
                      disabled={disabled}
                      onClick={() => onRemoveValueFlag(filter, "includeNaN")}
                    />
                  )}
                  {filter.predicates.map((predicate, index) => (
                    <FilterRuleButton
                      key={`predicate:${predicate.operator}:${index}`}
                      columnLabel={columnLabel}
                      summary={predicateLabel(predicate)}
                      disabled={disabled}
                      onClick={() => onRemovePredicate(filter, index)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FilterRuleButton({
  columnLabel,
  summary,
  disabled,
  onClick
}: {
  columnLabel: string;
  summary: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      className="rulePill rulePillButton"
      disabled={disabled}
      aria-label={`Remove ${summary} filter from ${columnLabel}`}
      title={`Remove ${summary} filter from ${columnLabel}`}
      onClick={onClick}
    >
      <span>{summary}</span>
      <span className="codicon codicon-close" aria-hidden="true" />
    </button>
  );
}

const columnOptionLabel = (name: string, position: number, nameCounts: ReadonlyMap<string, number>): string =>
  (nameCounts.get(name) ?? 0) > 1 ? `${name} (column ${position + 1})` : name;

const activeFilterColumnLabel = (name: string, metadata: SessionMetadata): string => {
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

const predicateLabel = (predicate: PredicateFilter): string => {
  const operator = predicateLabels[predicate.operator];
  if (!operatorRequiresValue(predicate.operator)) return operator;
  const value = filterValueLabel(predicate.value);
  return predicate.operator === "between"
    ? `${operator} ${value} and ${filterValueLabel(predicate.secondValue)}`
    : `${operator} ${value}`;
};

const filterValueLabel = (value: unknown): string => {
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

const quotedCompactText = (value: string): string => compactText(JSON.stringify(value));

const compactText = (value: string): string => (value.length <= 48 ? value : `${value.slice(0, 45)}…`);

const selectionValueKey = (value: unknown): string => {
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
  // Existing runtimes return display strings. Keep their historical string
  // identity so an already-active legacy filter remains checked.
  return `legacy:${String(value)}`;
};

const isTypedSelectionToken = (value: unknown): value is TypedSelectionToken => {
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

const coercePredicateValue = (value: string, columnType: ColumnType): string | number | boolean => {
  if (columnType === "boolean") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    return value;
  }
  // Preserve integer and decimal text exactly; the runtime binds it against
  // the native dtype without routing through JavaScript's 53-bit number.
  if (columnType !== "float") return value;
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
};

const operatorRequiresValue = (operator: PredicateOperator): boolean =>
  !["isNull", "isNotNull", "isNaN", "isNotNaN"].includes(operator);

const hasCompletePredicateValues = (operator: PredicateOperator, value: string, secondValue: string): boolean =>
  !operatorRequiresValue(operator) || (value !== "" && (operator !== "between" || secondValue !== ""));

const createPredicate = (
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
