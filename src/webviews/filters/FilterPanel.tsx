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
import {
  ambiguousViewColumnMessage,
  countViewColumnNames,
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
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const modelSortKey = sortRulesKey(model.sort);
  const [sortEditor, setSortEditor] = useState(() => ({ modelKey: modelSortKey, rules: model.sort }));
  const draftSort = sortEditor.modelKey === modelSortKey ? sortEditor.rules : model.sort;
  const [sortOpen, setSortOpen] = useState(model.sort.length > 0);
  const [advanced, setAdvanced] = useState(defaultAdvanced);
  const viewColumnNameCounts = useMemo(() => countViewColumnNames(metadata?.schema ?? []), [metadata?.schema]);

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
  const ambiguityMessage = activeColumnAmbiguous
    ? ambiguousViewColumnMessage(activeColumn, activeColumnNameCount)
    : undefined;
  const viewQueryControlsDisabled = disabled || activeColumnAmbiguous;
  const supportsTypedComparison = columnSchema ? supportsTypedViewComparison(columnSchema.type) : false;
  const availableOperators = columnSchema ? viewPredicateOperators(columnSchema.type) : [];
  const activePredicateOperator = availableOperators.includes(predicateOperator)
    ? predicateOperator
    : (availableOperators[0] ?? "isNull");
  const columnValueResponse = activeColumn && !activeColumnAmbiguous ? values.get(activeColumn) : undefined;

  const activeFilter = model.filters.find((item) => item.column === activeColumn);
  const selectedValues = new Map(
    (activeFilter?.valueFilter?.selectedValues ?? []).map((value) => [selectionValueKey(value), value])
  );

  if (!metadata) {
    return <section className="panel">Preparing filters...</section>;
  }

  const updateFilter = (nextFilter: ColumnFilter) => {
    if (viewQueryControlsDisabled || !nextFilter.column) return;
    const filters = model.filters.filter((item) => item.column !== nextFilter.column);
    onApply({ ...model, filters: [...filters, nextFilter] });
  };

  const toggleValue = (value: unknown) => {
    if (viewQueryControlsDisabled || !columnSchema || !activeColumn || !supportsTypedComparison) {
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
      logic: model.filters.find((item) => item.column === activeColumn)?.logic ?? "and",
      valueFilter: {
        kind: "values",
        selectedValues: [...nextSelected.values()],
        includeNulls: false,
        includeNaN: false,
        search
      },
      predicates: model.filters.find((item) => item.column === activeColumn)?.predicates ?? []
    });
  };

  const addPredicate = () => {
    if (
      viewQueryControlsDisabled ||
      !columnSchema ||
      !activeColumn ||
      !availableOperators.includes(activePredicateOperator) ||
      !hasCompletePredicateValues(activePredicateOperator, predicateValue, secondPredicateValue)
    ) {
      return;
    }
    const existing = model.filters.find((item) => item.column === activeColumn);
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
    if (viewQueryControlsDisabled || !columnSchema || !activeColumn || !supportsTypedComparison) return;
    const existingIndex = draftSort.findIndex((rule) => rule.column === activeColumn);
    const nextRule = { column: activeColumn, direction: sortDirection, nulls: "last" as const };
    setSortEditor({
      modelKey: modelSortKey,
      rules:
        existingIndex < 0
          ? [...draftSort, nextRule]
          : draftSort.map((rule, index) => (index === existingIndex ? nextRule : rule))
    });
  };

  const removeSort = (index: number) => {
    if (disabled) return;
    setSortEditor({ modelKey: modelSortKey, rules: draftSort.filter((_, ruleIndex) => ruleIndex !== index) });
  };

  const toggleSortDirection = (index: number) => {
    if (disabled) return;
    setSortEditor({
      modelKey: modelSortKey,
      rules: draftSort.map((rule, ruleIndex) =>
        ruleIndex === index ? { ...rule, direction: rule.direction === "asc" ? "desc" : "asc" } : rule
      )
    });
  };
  const sortDirty = !sameSortRules(draftSort, model.sort);

  const clearColumn = () => {
    if (disabled || !columnSchema || !activeColumn) return;
    onApply({
      ...model,
      filters: model.filters.filter((item) => item.column !== activeColumn),
      sort: model.sort.filter((rule) => rule.column !== activeColumn)
    });
  };

  return (
    <section className="panel filterSortPanel" aria-busy={disabled}>
      <div className="panelHeader">
        <h2>Filters / Sorts</h2>
        <button type="button" disabled={disabled} onClick={() => onApply({ filters: [], sort: [] })}>
          Clear all
        </button>
      </div>

      <details className="filterSection" open>
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
            disabled={viewQueryControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (!viewQueryControlsDisabled && supportsTypedComparison && event.key === "Enter" && activeColumn) {
                onRequestValues(activeColumn, search);
              }
            }}
          />
          <button
            type="button"
            disabled={viewQueryControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onClick={() => {
              if (activeColumn) onRequestValues(activeColumn, search);
            }}
          >
            Values
          </button>
        </div>

        <div className="valueList">
          {(columnValueResponse?.values ?? []).map((item) => {
            const selectionValue = item.selectionValue ?? item.value;
            const selectionKey = selectionValueKey(selectionValue);
            return (
              <label key={selectionKey} className="checkboxRow">
                <input
                  type="checkbox"
                  checked={selectedValues.has(selectionKey)}
                  disabled={viewQueryControlsDisabled || !supportsTypedComparison}
                  onChange={() => toggleValue(selectionValue)}
                />
                <span>{item.value}</span>
                <small>{item.count}</small>
              </label>
            );
          })}
          {columnValueResponse?.hasMore && <small>More values available. Refine the search to narrow results.</small>}
        </div>

        <div className="predicateBuilder">
          {advanced && (
            <select
              aria-label="Condition combination"
              value={model.filters.find((item) => item.column === activeColumn)?.logic ?? "and"}
              disabled={viewQueryControlsDisabled || !hasActiveColumn}
              onChange={(event) => {
                if (!columnSchema || !activeColumn) return;
                const existing = model.filters.find((item) => item.column === activeColumn);
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
            disabled={viewQueryControlsDisabled || !hasActiveColumn}
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
              placeholder="Value"
              disabled={viewQueryControlsDisabled || !hasActiveColumn}
              onChange={(event) => setPredicateValue(event.target.value)}
            />
          )}
          {activePredicateOperator === "between" && (
            <input
              aria-label="Between predicate upper bound"
              value={secondPredicateValue}
              placeholder="And"
              disabled={viewQueryControlsDisabled || !hasActiveColumn}
              onChange={(event) => setSecondPredicateValue(event.target.value)}
            />
          )}
          <button
            type="button"
            disabled={
              viewQueryControlsDisabled ||
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

        <div className="activeRules">
          {(model.filters.find((item) => item.column === activeColumn)?.predicates ?? []).map((predicate, index) => (
            <span key={`${predicate.operator}-${index}`} className="rulePill">
              {predicate.operator}
              {predicate.value === undefined ? "" : ` ${String(predicate.value)}`}
            </span>
          ))}
        </div>

        <button type="button" disabled={disabled || !hasActiveColumn} onClick={clearColumn}>
          Clear column
        </button>
      </details>

      <details className="filterSection" open={sortOpen} onToggle={(event) => setSortOpen(event.currentTarget.open)}>
        <summary>SORTS</summary>
        <label>
          Column
          <select
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
            disabled={viewQueryControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onChange={(event) => setSortDirection(event.target.value as SortDirection)}
          >
            <option value="asc">Sort ascending</option>
            <option value="desc">Sort descending</option>
          </select>
          <button
            type="button"
            disabled={viewQueryControlsDisabled || !hasActiveColumn || !supportsTypedComparison}
            onClick={applySort}
          >
            {draftSort.some((rule) => rule.column === activeColumn) ? "Update sort" : "Add to sort"}
          </button>
        </div>
        <p className="panelNote">
          {draftSort.some((rule) => rule.column === activeColumn)
            ? "Update this column in place without changing its priority."
            : "Add this column after the existing rules. Header sorting replaces this list with one primary sort."}{" "}
          Changes stay local until you apply the sort order.
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
                return (
                  <li key={rule.column} className="sortRule">
                    <span className="sortRulePriority" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="sortRuleColumn">{rule.column}</span>
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
                      className="iconButton codicon codicon-close"
                      disabled={disabled}
                      aria-label={`Remove sort ${index + 1}, ${rule.column}, ${directionLabel}`}
                      onClick={() => removeSort(index)}
                    />
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
            onClick={() => setSortEditor({ modelKey: modelSortKey, rules: model.sort })}
          >
            Discard sort changes
          </button>
        </div>
      </details>
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

const columnOptionLabel = (name: string, position: number, nameCounts: ReadonlyMap<string, number>): string =>
  (nameCounts.get(name) ?? 0) > 1 ? `${name} (column ${position + 1})` : name;

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
