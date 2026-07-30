import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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

const resultHeight = 32;
const maximumResultViewportHeight = 360;
const resultOverscan = 4;

export function ColumnSearch({ columns, selectedColumnId, onSelect }: ColumnSearchProps) {
  const generatedId = useId().replaceAll(":", "");
  const inputId = `openwrangler-column-search-${generatedId}`;
  const listboxId = `${inputId}-results`;
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const resultsRef = useRef<HTMLUListElement | null>(null);
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
  const results = matchingColumns;
  const boundedActiveIndex = Math.min(activeIndex, Math.max(0, results.length - 1));
  const activeColumn = results[boundedActiveIndex];
  const activeOptionId = activeColumn ? `${listboxId}-option-${boundedActiveIndex}` : undefined;
  const renderedIndices = useMemo(() => {
    const firstVisibleIndex = Math.floor(scrollTop / resultHeight);
    const start = Math.max(0, firstVisibleIndex - resultOverscan);
    const end = Math.min(
      results.length,
      Math.ceil((scrollTop + maximumResultViewportHeight) / resultHeight) + resultOverscan
    );
    const indices = Array.from({ length: Math.max(0, end - start) }, (_, offset) => start + offset);
    if (activeColumn && (boundedActiveIndex < start || boundedActiveIndex >= end)) {
      indices.push(boundedActiveIndex);
      indices.sort((left, right) => left - right);
    }
    return indices;
  }, [activeColumn, boundedActiveIndex, results.length, scrollTop]);

  useEffect(() => {
    const listbox = resultsRef.current;
    if (!open || !activeColumn || !listbox) return;
    const viewportHeight = listbox.clientHeight || maximumResultViewportHeight;
    const optionTop = boundedActiveIndex * resultHeight;
    const optionBottom = optionTop + resultHeight;
    let nextScrollTop = listbox.scrollTop;
    if (optionTop < listbox.scrollTop) {
      nextScrollTop = optionTop;
    } else if (optionBottom > listbox.scrollTop + viewportHeight) {
      nextScrollTop = optionBottom - viewportHeight;
    }
    if (nextScrollTop === listbox.scrollTop) return;
    listbox.scrollTop = nextScrollTop;
    setScrollTop(nextScrollTop);
  }, [activeColumn, boundedActiveIndex, open, query]);

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
    if ((event.key === "PageDown" || event.key === "PageUp") && open && results.length > 0) {
      event.preventDefault();
      const pageSize = Math.max(1, Math.floor(maximumResultViewportHeight / resultHeight) - 1);
      const delta = event.key === "PageDown" ? pageSize : -pageSize;
      setActiveIndex((current) => Math.max(0, Math.min(results.length - 1, current + delta)));
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
            <ul
              ref={resultsRef}
              id={listboxId}
              className="columnSearchResults"
              role="listbox"
              aria-label="Matching columns"
              style={
                {
                  "--column-search-content-height": `${results.length * resultHeight}px`,
                  "--column-search-result-height": `${resultHeight}px`,
                  "--column-search-viewport-height": `${maximumResultViewportHeight}px`
                } as CSSProperties
              }
              onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
            >
              {renderedIndices.map((index) => {
                const column = results[index];
                if (!column) return null;
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
                    id={`${listboxId}-option-${index}`}
                    key={column.id}
                    role="option"
                    aria-label={optionLabel}
                    aria-selected={index === boundedActiveIndex}
                    aria-posinset={index + 1}
                    aria-setsize={results.length}
                    className={[index === boundedActiveIndex ? "active" : "", selected ? "selected" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ top: index * resultHeight }}
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
          </div>
        )}
      </div>
    </div>
  );
}
