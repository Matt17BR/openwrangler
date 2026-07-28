import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent
} from "react";
import type { ColumnSchema } from "../shared/protocol";
import { columnTypePresentation } from "./columnTypes";

interface ColumnSearchProps {
  columns: ColumnSchema[];
  selectedColumnId?: string;
  onSelect(columnId: string): void;
}

const maximumVisibleResults = 100;

export function ColumnSearch({ columns, selectedColumnId, onSelect }: ColumnSearchProps) {
  const generatedId = useId().replaceAll(":", "");
  const inputId = `openwrangler-column-search-${generatedId}`;
  const listboxId = `${inputId}-results`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const activeOptionRef = useRef<HTMLLIElement | null>(null);
  const duplicateNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const column of columns) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
    return counts;
  }, [columns]);
  const matchingColumns = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return columns;
    return columns.filter((column) => {
      const type = columnTypePresentation(column);
      return [column.name, column.rawType, column.type, type.label].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [columns, query]);
  const results = matchingColumns.slice(0, maximumVisibleResults);
  const boundedActiveIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
  const activeColumn = results[boundedActiveIndex];
  const activeOptionId = activeColumn ? `${listboxId}-option-${boundedActiveIndex}` : undefined;

  useEffect(() => {
    if (!open) return;
    activeOptionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [boundedActiveIndex, open, query]);

  const openResults = () => {
    const selectedIndex = results.findIndex((column) => column.id === selectedColumnId);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const selectColumn = (column: ColumnSchema) => {
    setQuery(column.name);
    setOpen(false);
    onSelect(column.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        openResults();
        return;
      }
      if (results.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + delta + results.length) % results.length);
      return;
    }
    if (event.key === "Home" && open && results.length > 0) {
      event.preventDefault();
      setActiveIndex(0);
      return;
    }
    if (event.key === "End" && open && results.length > 0) {
      event.preventDefault();
      setActiveIndex(results.length - 1);
      return;
    }
    if (event.key === "Enter" && open && activeColumn) {
      event.preventDefault();
      selectColumn(activeColumn);
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setOpen(false);
  };

  return (
    <div className="goToColumn">
      <label htmlFor={inputId}>Column</label>
      <div className="columnSearchControl" onBlur={handleBlur}>
        <span className="columnSearchInputIcon codicon codicon-search" aria-hidden="true" />
        <input
          id={inputId}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open ? activeOptionId : undefined}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Search columns"
          onFocus={openResults}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
        />
        {open && (
          <div className="columnSearchPopup">
            <ul id={listboxId} className="columnSearchResults" role="listbox" aria-label="Matching columns">
              {results.map((column, index) => {
                const type = columnTypePresentation(column);
                const duplicate = (duplicateNameCounts.get(column.name) ?? 0) > 1;
                const selected = column.id === selectedColumnId;
                const optionLabel = [
                  column.name,
                  `${type.label} column`,
                  duplicate ? `column ${column.position + 1}` : undefined
                ]
                  .filter(Boolean)
                  .join(", ");
                return (
                  <li
                    ref={index === boundedActiveIndex ? activeOptionRef : undefined}
                    id={`${listboxId}-option-${index}`}
                    key={column.id}
                    role="option"
                    aria-label={optionLabel}
                    aria-selected={index === boundedActiveIndex}
                    className={[index === boundedActiveIndex ? "active" : "", selected ? "selected" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    title={`${column.name}: ${type.label} (${column.rawType}), column ${column.position + 1}`}
                    onMouseDown={(event: MouseEvent<HTMLLIElement>) => event.preventDefault()}
                    onMouseMove={() => setActiveIndex(index)}
                    onClick={() => selectColumn(column)}
                  >
                    <span
                      className={`columnSearchTypeIcon codicon ${type.icon}`}
                      role="img"
                      aria-label={`${type.label} column type`}
                      title={`${type.label} column type`}
                    />
                    <span className="columnSearchName">{column.name}</span>
                    <span className="columnSearchType">{type.label}</span>
                    {duplicate && <span className="columnSearchPosition">Column {column.position + 1}</span>}
                  </li>
                );
              })}
            </ul>
            {results.length === 0 && (
              <p className="columnSearchEmpty" role="status">
                No matching columns
              </p>
            )}
            {matchingColumns.length > results.length && (
              <p className="columnSearchCount" role="status">
                Showing {results.length} of {matchingColumns.length} matches. Keep typing to narrow the list.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
