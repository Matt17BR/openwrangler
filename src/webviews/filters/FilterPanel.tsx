import { useMemo, useState } from "react";
import type { SessionMetadata, ValuesResponse } from "../../shared/protocol";
import type { ColumnFilter, FilterModel, PredicateOperator, SortDirection } from "../../shared/filterModel";

interface FilterPanelProps {
  metadata: SessionMetadata | undefined;
  model: FilterModel;
  values: Record<string, ValuesResponse>;
  activeColumn?: string;
  defaultAdvanced?: boolean;
  onApply(model: FilterModel): void;
  onRequestValues(column: string, search?: string): void;
}

const operators: PredicateOperator[] = [
  "contains",
  "startsWith",
  "endsWith",
  "equals",
  "notEquals",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isNull",
  "isNotNull",
  "isNaN",
  "isNotNaN"
];

export function FilterPanel({
  metadata,
  model,
  values,
  activeColumn: requestedColumn,
  defaultAdvanced = false,
  onApply,
  onRequestValues
}: FilterPanelProps) {
  const firstColumn = metadata?.schema[0]?.name ?? "";
  const [column, setColumn] = useState(requestedColumn || firstColumn);
  const [search, setSearch] = useState("");
  const [predicateOperator, setPredicateOperator] = useState<PredicateOperator>("contains");
  const [predicateValue, setPredicateValue] = useState("");
  const [secondPredicateValue, setSecondPredicateValue] = useState("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [advanced, setAdvanced] = useState(defaultAdvanced);

  const activeColumn = column || firstColumn;
  const columnSchema = metadata?.schema.find((item) => item.name === activeColumn);
  const columnValueResponse = values[activeColumn];

  const selectedValues = useMemo(() => {
    const filter = model.filters.find((item) => item.column === activeColumn);
    return new Set(filter?.valueFilter?.selectedValues.map(String) ?? []);
  }, [activeColumn, model.filters]);

  if (!metadata) {
    return <section className="panel">Preparing filters...</section>;
  }

  const updateFilter = (nextFilter: ColumnFilter) => {
    const filters = model.filters.filter((item) => item.column !== nextFilter.column);
    onApply({ ...model, filters: [...filters, nextFilter] });
  };

  const toggleValue = (value: string) => {
    if (!columnSchema) {
      return;
    }
    const nextSelected = new Set(selectedValues);
    if (nextSelected.has(value)) {
      nextSelected.delete(value);
    } else {
      nextSelected.add(value);
    }
    updateFilter({
      column: activeColumn,
      type: columnSchema.type,
      logic: model.filters.find((item) => item.column === activeColumn)?.logic ?? "and",
      valueFilter: {
        kind: "values",
        selectedValues: [...nextSelected],
        includeNulls: false,
        includeNaN: false,
        search
      },
      predicates: model.filters.find((item) => item.column === activeColumn)?.predicates ?? []
    });
  };

  const addPredicate = () => {
    if (!columnSchema || (operatorRequiresValue(predicateOperator) && !predicateValue)) {
      return;
    }
    const existing = model.filters.find((item) => item.column === activeColumn);
    updateFilter({
      column: activeColumn,
      type: columnSchema.type,
      logic: existing?.logic ?? "and",
      valueFilter: existing?.valueFilter,
      predicates: [
        ...(existing?.predicates ?? []),
        {
          kind: "predicate",
          operator: predicateOperator,
          value: coercePredicateValue(predicateValue),
          secondValue: predicateOperator === "between" ? coercePredicateValue(secondPredicateValue) : undefined
        }
      ]
    });
    setPredicateValue("");
    setSecondPredicateValue("");
  };

  const applySort = () => {
    onApply({
      ...model,
      sort: [
        ...model.sort.filter((rule) => rule.column !== activeColumn),
        { column: activeColumn, direction: sortDirection, nulls: "last" }
      ]
    });
  };

  const clearColumn = () => {
    onApply({
      ...model,
      filters: model.filters.filter((item) => item.column !== activeColumn),
      sort: model.sort.filter((rule) => rule.column !== activeColumn)
    });
  };

  return (
    <section className="panel filterSortPanel">
      <div className="panelHeader">
        <h2>Filters / Sorts</h2>
        <button type="button" onClick={() => onApply({ filters: [], sort: [] })}>
          Clear all
        </button>
      </div>

      <details className="filterSection" open>
        <summary>FILTERS</summary>
        <button type="button" className="secondaryButton" onClick={() => setAdvanced((current) => !current)}>
          {advanced ? "Use basic filters" : "Use advanced filters"}
        </button>
        {advanced && (
          <label>
            Across columns
            <select
              value={model.logic ?? "and"}
              onChange={(event) => onApply({ ...model, logic: event.target.value as "and" | "or" })}
            >
              <option value="and">Match every filtered column</option>
              <option value="or">Match any filtered column</option>
            </select>
          </label>
        )}
        <label>
          Column
          <select value={activeColumn} onChange={(event) => setColumn(event.target.value)}>
            {metadata.schema.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <div className="row">
          <input
            value={search}
            placeholder="Search values"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                onRequestValues(activeColumn, search);
              }
            }}
          />
          <button type="button" onClick={() => onRequestValues(activeColumn, search)}>
            Values
          </button>
        </div>

        <div className="valueList">
          {(columnValueResponse?.values ?? []).map((item) => (
            <label key={item.value} className="checkboxRow">
              <input
                type="checkbox"
                checked={selectedValues.has(item.value)}
                onChange={() => toggleValue(item.value)}
              />
              <span>{item.value}</span>
              <small>{item.count}</small>
            </label>
          ))}
          {columnValueResponse?.hasMore && <small>More values available. Refine the search to narrow results.</small>}
        </div>

        <div className="predicateBuilder">
          {advanced && (
            <select
              aria-label="Condition combination"
              value={model.filters.find((item) => item.column === activeColumn)?.logic ?? "and"}
              onChange={(event) => {
                if (!columnSchema) return;
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
            value={predicateOperator}
            onChange={(event) => setPredicateOperator(event.target.value as PredicateOperator)}
          >
            {operators.map((operator) => (
              <option key={operator} value={operator}>
                {operator}
              </option>
            ))}
          </select>
          {operatorRequiresValue(predicateOperator) && (
            <input
              value={predicateValue}
              placeholder="Value"
              onChange={(event) => setPredicateValue(event.target.value)}
            />
          )}
          {predicateOperator === "between" && (
            <input
              value={secondPredicateValue}
              placeholder="And"
              onChange={(event) => setSecondPredicateValue(event.target.value)}
            />
          )}
          <button type="button" onClick={addPredicate}>
            Add predicate
          </button>
        </div>

        <div className="activeRules">
          {(model.filters.find((item) => item.column === activeColumn)?.predicates ?? []).map((predicate, index) => (
            <span key={`${predicate.operator}-${index}`} className="rulePill">
              {predicate.operator}
              {predicate.value === undefined ? "" : ` ${String(predicate.value)}`}
            </span>
          ))}
        </div>

        <button type="button" onClick={clearColumn}>
          Clear column
        </button>
      </details>

      <details className="filterSection" open={model.sort.length > 0}>
        <summary>SORTS</summary>
        <label>
          Column
          <select value={activeColumn} onChange={(event) => setColumn(event.target.value)}>
            {metadata.schema.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <select
            aria-label="Sort direction"
            value={sortDirection}
            onChange={(event) => setSortDirection(event.target.value as SortDirection)}
          >
            <option value="asc">Sort ascending</option>
            <option value="desc">Sort descending</option>
          </select>
          <button type="button" onClick={applySort}>
            Add sort
          </button>
        </div>
        <div className="activeRules">
          {model.sort.length === 0 && <span className="mutedText">No active sorts.</span>}
          {model.sort.map((rule) => (
            <span key={rule.column} className="rulePill">
              {rule.column} {rule.direction === "asc" ? "asc" : "desc"}
            </span>
          ))}
        </div>
      </details>
    </section>
  );
}

const coercePredicateValue = (value: string): string | number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
};

const operatorRequiresValue = (operator: PredicateOperator): boolean =>
  !["isNull", "isNotNull", "isNaN", "isNotNaN"].includes(operator);
