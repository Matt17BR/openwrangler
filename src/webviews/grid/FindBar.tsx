import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import { MAX_FIND_QUERY_CODE_POINTS } from "../../shared/find";
import type { ColumnSchema } from "../../shared/protocol";
import { isFindableColumn, type GridFindController, type GridFindStatus } from "./useGridFind";

interface FindBarProps {
  controller: GridFindController;
  schema: readonly ColumnSchema[];
}

export function FindBar({ controller, schema }: FindBarProps) {
  const { criteria, status, focusRequestId, unavailableReason } = controller;
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const statusId = useId();
  const searchable = schema.filter(isFindableColumn);
  const disabled = unavailableReason !== undefined;
  const canStep = !disabled && criteria.text.length > 0;

  useEffect(() => {
    if (disabled) {
      closeRef.current?.focus();
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [disabled, focusRequestId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const modifier = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    // macOS Option composes a character instead of a letter, so fall back to the physical key.
    const altLetter =
      event.altKey && !modifier && !event.shiftKey
        ? /^[a-z]$/.test(key)
          ? key
          : /^Key[A-Z]$/.test(event.code)
            ? event.code.slice(3).toLowerCase()
            : undefined
        : undefined;
    let handled = true;
    if (event.key === "Escape") controller.close();
    else if (event.key === "F3" && !modifier && !event.altKey) {
      if (canStep) controller.step(event.shiftKey ? "previous" : "next");
    } else if (event.key === "Enter" && event.target === inputRef.current && !modifier && !event.altKey) {
      if (canStep) controller.step(event.shiftKey ? "previous" : "next");
    } else if (modifier && !event.altKey && !event.shiftKey && key === "f") {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (altLetter === "c" && !disabled) {
      controller.changeOptions({ matchCase: !criteria.matchCase });
    } else if (altLetter === "w" && !disabled) {
      controller.changeOptions({ wholeCell: !criteria.wholeCell });
    } else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div className="findBar" role="search" aria-label="Find in grid" onKeyDown={handleKeyDown}>
      <input
        ref={inputRef}
        className="findInput"
        aria-label="Find"
        aria-describedby={statusId}
        aria-keyshortcuts="Enter Shift+Enter F3 Shift+F3"
        autoComplete="off"
        disabled={disabled}
        placeholder="Find"
        spellCheck={false}
        value={criteria.text}
        onChange={(event) => controller.changeText(truncateCodePoints(event.target.value))}
      />
      <button
        type="button"
        className="gridNavigationButton findToggle"
        aria-label="Match case"
        aria-pressed={criteria.matchCase}
        aria-keyshortcuts="Alt+C"
        title="Match case (Alt+C)"
        disabled={disabled}
        onClick={() => controller.changeOptions({ matchCase: !criteria.matchCase })}
      >
        <span className="codicon codicon-case-sensitive" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="gridNavigationButton findToggle"
        aria-label="Match whole cell"
        aria-pressed={criteria.wholeCell}
        aria-keyshortcuts="Alt+W"
        title="Match whole cell (Alt+W)"
        disabled={disabled}
        onClick={() => controller.changeOptions({ wholeCell: !criteria.wholeCell })}
      >
        <span className="codicon codicon-whole-word" aria-hidden="true" />
      </button>
      <select
        className="findScope"
        aria-label="Search in"
        disabled={disabled}
        value={criteria.scope ?? ""}
        onChange={(event) => controller.changeOptions({ scope: event.target.value || undefined })}
      >
        <option value="">All columns</option>
        {searchable.map((column) => (
          <option key={column.id} value={column.id}>
            {column.name}
          </option>
        ))}
      </select>
      <span
        id={statusId}
        className={status.kind === "error" ? "findStatus findStatusError" : "findStatus"}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {unavailableReason ?? findStatusText(status)}
        {status.kind === "found" && unavailableReason === undefined && (
          <span className="findStatusLocation">
            {`, row ${(status.cell.row + 1).toLocaleString()}, ${
              schema.find((column) => column.id === status.cell.columnId)?.name ?? "unknown column"
            }`}
          </span>
        )}
      </span>
      <button
        type="button"
        className="gridNavigationButton"
        aria-label="Previous match"
        aria-keyshortcuts="Shift+Enter Shift+F3"
        title="Previous match (Shift+Enter)"
        disabled={!canStep}
        onClick={() => controller.step("previous")}
      >
        <span className="codicon codicon-arrow-up" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="gridNavigationButton"
        aria-label="Next match"
        aria-keyshortcuts="Enter F3"
        title="Next match (Enter)"
        disabled={!canStep}
        onClick={() => controller.step("next")}
      >
        <span className="codicon codicon-arrow-down" aria-hidden="true" />
      </button>
      <button
        ref={closeRef}
        type="button"
        className="gridNavigationButton"
        aria-label="Close Find"
        aria-keyshortcuts="Escape"
        title="Close (Escape)"
        onClick={controller.close}
      >
        <span className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}

function findStatusText(status: GridFindStatus): string {
  switch (status.kind) {
    case "pending":
      return "Searching…";
    case "found":
      return `${status.ordinal.toLocaleString()} of ${status.count.toLocaleString()}`;
    case "none":
      return "No results";
    case "error":
      return status.message;
    case "idle":
      return "";
  }
}

function truncateCodePoints(text: string): string {
  if (text.length <= MAX_FIND_QUERY_CODE_POINTS) return text;
  return Array.from(text).slice(0, MAX_FIND_QUERY_CODE_POINTS).join("");
}
