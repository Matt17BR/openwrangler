import { useMemo, useState } from "react";
import type { SessionMetadata, ValuesResponse } from "../../shared/protocol";
import type { ColumnFilter, FilterModel, PredicateOperator, SortDirection } from "../../shared/filterModel";

interface FilterPanelProps {
  metadata: SessionMetadata | undefined;
  model: FilterModel;
  values: Record<string, ValuesResponse>;
  disabledReason?: string;
  onApply(model: FilterModel): void;
  onRequestValues(column: string, search?: string): void;
}

const operators: PredicateOperator[] = ["contains", "equals", "gt", "gte", "lt", "lte", "between"];

export function FilterPanel({
  metadata,
  model,
  values,
  disabledReason,
  onApply,
  onRequestValues
}: FilterPanelProps): JSX.Element {
  const firstColumn = metadata?.schema[0]?.name ?? "";
  const [column, setColumn] = useState(firstColumn);
  const [search, setSearch] = useState("");
  const [predicateOperator, setPredicateOperator] = useState<PredicateOperator>("contains");
  const [predicateValue, setPredicateValue] = useState("");
  const [secondPredicateValue, setSecondPredicateValue] = useState("");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

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
    if (disabledReason) {
      return;
    }
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
    if (!columnSchema || !predicateValue) {
      return;
    }
    const existing = model.filters.find((item) => item.column === activeColumn);
    updateFilter({
      column: activeColumn,
      type: columnSchema.type,
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
    if (disabledReason) {
      return;
    }
    onApply({
      ...model,
      sort: [
        ...model.sort.filter((rule) => rule.column !== activeColumn),
        { column: activeColumn, direction: sortDirection, nulls: "last" }
      ]
    });
  };

  const clearColumn = () => {
    if (disabledReason) {
      return;
    }
    onApply({
      filters: model.filters.filter((item) => item.column !== activeColumn),
      sort: model.sort.filter((rule) => rule.column !== activeColumn)
    });
  };

  return (
    <section className="panel">
      <div className="panelHeader">
        <h2>Filters</h2>
        <button type="button" disabled={Boolean(disabledReason)} onClick={() => onApply({ filters: [], sort: [] })}>
          Clear all
        </button>
      </div>
      {disabledReason && <p className="panelNote">{disabledReason}</p>}

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
          value={sortDirection}
          disabled={Boolean(disabledReason)}
          onChange={(event) => setSortDirection(event.target.value as SortDirection)}
        >
          <option value="asc">Sort A to Z</option>
          <option value="desc">Sort Z to A</option>
        </select>
        <button type="button" disabled={Boolean(disabledReason)} onClick={applySort}>
          Add sort
        </button>
      </div>

      <div className="row">
        <input
          value={search}
          placeholder="Search values"
          disabled={Boolean(disabledReason)}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRequestValues(activeColumn, search);
            }
          }}
        />
        <button type="button" disabled={Boolean(disabledReason)} onClick={() => onRequestValues(activeColumn, search)}>
          Values
        </button>
      </div>

      <div className="valueList">
        {(columnValueResponse?.values ?? []).map((item) => (
          <label key={item.value} className="checkboxRow">
            <input
              type="checkbox"
              checked={selectedValues.has(item.value)}
              disabled={Boolean(disabledReason)}
              onChange={() => toggleValue(item.value)}
            />
            <span>{item.value}</span>
            <small>{item.count}</small>
          </label>
        ))}
        {columnValueResponse?.hasMore && <small>More values available. Refine the search to narrow results.</small>}
      </div>

      <div className="predicateBuilder">
        <select
          value={predicateOperator}
          disabled={Boolean(disabledReason)}
          onChange={(event) => setPredicateOperator(event.target.value as PredicateOperator)}
        >
          {operators.map((operator) => (
            <option key={operator} value={operator}>
              {operator}
            </option>
          ))}
        </select>
        <input
          value={predicateValue}
          disabled={Boolean(disabledReason)}
          placeholder="Value"
          onChange={(event) => setPredicateValue(event.target.value)}
        />
        {predicateOperator === "between" && (
          <input
            value={secondPredicateValue}
            disabled={Boolean(disabledReason)}
            placeholder="And"
            onChange={(event) => setSecondPredicateValue(event.target.value)}
          />
        )}
        <button type="button" disabled={Boolean(disabledReason)} onClick={addPredicate}>
          Add predicate
        </button>
      </div>

      <button type="button" disabled={Boolean(disabledReason)} onClick={clearColumn}>
        Clear column
      </button>
    </section>
  );
}

const coercePredicateValue = (value: string): string | number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && value.trim() !== "" ? numeric : value;
};
