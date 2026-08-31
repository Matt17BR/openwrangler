import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEventHandler, ReactNode } from "react";
import type { SortDirection, SortRule } from "../../shared/filterModel";
import { ambiguousViewColumnMessage, supportsTypedViewComparison } from "../../shared/filterModel";
import type { ColumnSchema } from "../../shared/protocol";
import { columnTypePresentation } from "../columnTypes";
import type { BeginColumnResize } from "./useColumnResizeLifecycle";

export function GridColumnHeader({
  column,
  ariaColumnIndex,
  width,
  selected,
  clipboardSelected,
  clipboardAction,
  logicalViewOwner,
  added,
  headerProfile,
  viewControlsDisabled,
  viewControlsDisabledReason,
  filterControlsDisabled,
  filterControlsDisabledReason,
  sortControlsDisabled,
  sortControlsDisabledReason,
  viewColumnNameCount,
  activeSort,
  activeSortIndex,
  sortCount,
  onOpenFilter,
  onSortColumn,
  onClearSortColumn,
  onSelect,
  onCopy,
  onBeginResize,
  onResize
}: {
  column: ColumnSchema;
  ariaColumnIndex: number;
  width: number;
  selected: boolean;
  clipboardSelected: boolean;
  clipboardAction: {
    ariaLabel: string;
    disabled: boolean;
    menuLabel: string;
    title: string;
  };
  logicalViewOwner: string;
  added: boolean;
  headerProfile(filterAvailable: boolean): ReactNode;
  viewControlsDisabled: boolean;
  viewControlsDisabledReason: string;
  filterControlsDisabled: boolean;
  filterControlsDisabledReason: string;
  sortControlsDisabled: boolean;
  sortControlsDisabledReason: string;
  viewColumnNameCount: number;
  activeSort: SortRule | undefined;
  activeSortIndex: number | undefined;
  sortCount: number;
  onOpenFilter(column: string): void;
  onSortColumn(column: string, direction: SortDirection): void;
  onClearSortColumn(column: string): void;
  onSelect(): void;
  onCopy(): Promise<boolean>;
  onBeginResize: BeginColumnResize;
  onResize(width: number): void;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const logicalViewOwnerRef = useRef(logicalViewOwner);
  useLayoutEffect(() => {
    logicalViewOwnerRef.current = logicalViewOwner;
  }, [logicalViewOwner]);
  const menuGenerationRef = useRef(0);
  const menuOperationGenerationRef = useRef(0);
  const clipboardOperationGenerationRef = useRef(0);
  const pendingClipboardOperationCountRef = useRef(0);
  const mountedRef = useRef(true);
  const [clipboardOperationState, setClipboardOperationState] = useState({ generation: 0, pending: 0 });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const disabledDescriptionId = `column-view-controls-disabled-${column.position}`;
  const filterDisabledDescriptionId = `column-filter-disabled-${column.position}`;
  const sortDisabledDescriptionId = `column-sort-disabled-${column.position}`;
  const comparisonUnavailable = !supportsTypedViewComparison(column.type);
  const ambiguityReason =
    viewColumnNameCount > 1 ? ambiguousViewColumnMessage(column.name, viewColumnNameCount) : undefined;
  const filterUnavailable = viewControlsDisabled || filterControlsDisabled || ambiguityReason !== undefined;
  const filterUnavailableReason = viewControlsDisabled
    ? viewControlsDisabledReason
    : filterControlsDisabled
      ? filterControlsDisabledReason
      : ambiguityReason;
  const sortUnavailable = viewControlsDisabled || sortControlsDisabled || ambiguityReason !== undefined;
  const sortUnavailableReason = viewControlsDisabled
    ? viewControlsDisabledReason
    : sortControlsDisabled
      ? sortControlsDisabledReason
      : ambiguityReason;
  const beginResize: PointerEventHandler<HTMLButtonElement> = (event) => {
    if (viewControlsDisabled) return;
    onBeginResize(event, width, onResize);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (viewControlsDisabled) return;
    if (event.key === "ArrowLeft") onResize(Math.max(80, width - 10));
    else if (event.key === "ArrowRight") onResize(Math.min(640, width + 10));
    else if (event.key === "Home") onResize(80);
    else if (event.key === "End") onResize(640);
    else return;
    event.preventDefault();
  };
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };
  const runMenuAction = (action: () => void) => {
    closeMenu();
    action();
  };
  const runClipboardAction = async (): Promise<boolean> => {
    clipboardOperationGenerationRef.current += 1;
    pendingClipboardOperationCountRef.current += 1;
    setClipboardOperationState({
      generation: clipboardOperationGenerationRef.current,
      pending: pendingClipboardOperationCountRef.current
    });
    try {
      return await onCopy();
    } finally {
      pendingClipboardOperationCountRef.current -= 1;
      if (mountedRef.current) {
        setClipboardOperationState({
          generation: clipboardOperationGenerationRef.current,
          pending: pendingClipboardOperationCountRef.current
        });
      }
    }
  };
  const runClipboardMenuAction = async () => {
    const menu = menuRef.current;
    const menuGeneration = menuGenerationRef.current;
    const operationViewOwner = logicalViewOwner;
    const operationGeneration = ++menuOperationGenerationRef.current;
    if (
      (await runClipboardAction()) &&
      menuRef.current === menu &&
      menu?.open === true &&
      logicalViewOwnerRef.current === operationViewOwner &&
      menuGenerationRef.current === menuGeneration &&
      menuOperationGenerationRef.current === operationGeneration
    ) {
      closeMenu();
    }
  };
  const activeSortLabel =
    activeSort &&
    `${activeSort.direction === "asc" ? "ascending" : "descending"}${
      sortCount > 1 && activeSortIndex !== undefined ? `, priority ${activeSortIndex + 1} of ${sortCount}` : ""
    }`;

  return (
    <th
      data-column={column.name}
      data-grid-column={column.position}
      aria-colindex={ariaColumnIndex}
      aria-selected={selected || clipboardSelected}
      aria-sort={
        activeSortIndex === 0
          ? activeSort?.direction === "asc"
            ? "ascending"
            : activeSort?.direction === "desc"
              ? "descending"
              : undefined
          : undefined
      }
      aria-label={[
        column.name,
        clipboardSelected ? "whole filtered and sorted column selected" : "",
        added ? "added column" : "",
        activeSortLabel ? `sorted ${activeSortLabel}` : ""
      ]
        .filter(Boolean)
        .join(", ")}
      data-diff-state={added ? "added" : undefined}
      data-clipboard-selected={clipboardSelected ? "true" : undefined}
      data-clipboard-operation-generation={clipboardOperationState.generation}
      data-clipboard-operation-pending={clipboardOperationState.pending > 0 ? "true" : "false"}
      className={[
        selected ? "selectedColumn" : "",
        clipboardSelected ? "gridClipboardSelected" : "",
        added ? "diffAddedColumn" : ""
      ]
        .filter(Boolean)
        .join(" ")}
      title={`${column.rawType}${column.nullable ? " nullable" : ""}${added ? ", added column" : ""}`}
      tabIndex={0}
      onClick={(event) => {
        if (columnHeaderControlTarget(event.target, event.currentTarget)) return;
        onSelect();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          event.preventDefault();
          void runClipboardAction();
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      <div className="columnHeader">
        <span className="columnTitle" title={column.name}>
          {column.name}
        </span>
        <div className="columnMetaRow">
          <span className="columnType" title={column.rawType}>
            <span className={`typeIcon codicon ${columnTypePresentation(column).icon}`} aria-hidden="true" />
            <small>{column.rawType}</small>
          </span>
          <div className="columnHeaderActions">
            {activeSort && (
              <button
                type="button"
                className={`columnSortIndicator codicon ${
                  activeSort.direction === "asc" ? "codicon-arrow-up" : "codicon-arrow-down"
                }`}
                aria-label={`Clear sort for ${column.name}; currently ${activeSortLabel}`}
                disabled={sortUnavailable}
                title={sortUnavailable ? sortUnavailableReason : `Sorted ${activeSortLabel}. Clear sort`}
                onClick={() => onClearSortColumn(column.name)}
              >
                {sortCount > 1 && activeSortIndex !== undefined && (
                  <span className="sortPriority" aria-hidden="true">
                    {activeSortIndex + 1}
                  </span>
                )}
              </button>
            )}
            <details
              ref={menuRef}
              className="columnMenu"
              onToggle={() => {
                menuGenerationRef.current += 1;
              }}
            >
              <summary aria-label={`Column actions for ${column.name}`} className="codicon codicon-ellipsis" />
              <div className="columnMenuContent">
                {viewControlsDisabled && (
                  <span id={disabledDescriptionId} className="columnMenuNotice">
                    {viewControlsDisabledReason}
                  </span>
                )}
                {!viewControlsDisabled && filterControlsDisabled && (
                  <span id={filterDisabledDescriptionId} className="columnMenuNotice">
                    {filterControlsDisabledReason}
                  </span>
                )}
                {!viewControlsDisabled && sortControlsDisabled && (
                  <span id={sortDisabledDescriptionId} className="columnMenuNotice">
                    {sortControlsDisabledReason}
                  </span>
                )}
                <button
                  type="button"
                  aria-label={clipboardAction.ariaLabel}
                  disabled={clipboardAction.disabled}
                  title={clipboardAction.title}
                  onClick={() => void runClipboardMenuAction()}
                >
                  {clipboardAction.menuLabel}
                </button>
                <button
                  type="button"
                  disabled={filterUnavailable}
                  aria-describedby={
                    filterUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : filterControlsDisabled
                          ? filterDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={filterUnavailableReason}
                  onClick={() => runMenuAction(() => onOpenFilter(column.name))}
                >
                  Filter…
                </button>
                <button
                  type="button"
                  disabled={sortUnavailable || comparisonUnavailable}
                  aria-describedby={
                    sortUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : sortControlsDisabled
                          ? sortDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={
                    sortUnavailable
                      ? sortUnavailableReason
                      : comparisonUnavailable
                        ? `Sorting is unavailable for ${column.type} columns`
                        : undefined
                  }
                  onClick={() => runMenuAction(() => onSortColumn(column.name, "asc"))}
                >
                  Sort ascending
                </button>
                <button
                  type="button"
                  disabled={sortUnavailable || comparisonUnavailable}
                  aria-describedby={
                    sortUnavailable
                      ? viewControlsDisabled
                        ? disabledDescriptionId
                        : sortControlsDisabled
                          ? sortDisabledDescriptionId
                          : undefined
                      : undefined
                  }
                  title={
                    sortUnavailable
                      ? sortUnavailableReason
                      : comparisonUnavailable
                        ? `Sorting is unavailable for ${column.type} columns`
                        : undefined
                  }
                  onClick={() => runMenuAction(() => onSortColumn(column.name, "desc"))}
                >
                  Sort descending
                </button>
                {activeSort && (
                  <button
                    type="button"
                    disabled={sortUnavailable}
                    title={sortUnavailableReason}
                    onClick={() => runMenuAction(() => onClearSortColumn(column.name))}
                  >
                    Clear sort
                  </button>
                )}
              </div>
            </details>
          </div>
        </div>
        <button
          type="button"
          className="columnResizeHandle codicon codicon-gripper"
          aria-label={`Resize ${column.name} column`}
          disabled={viewControlsDisabled}
          aria-describedby={viewControlsDisabled ? disabledDescriptionId : undefined}
          title={viewControlsDisabled ? viewControlsDisabledReason : undefined}
          onPointerDown={beginResize}
          onKeyDown={resizeWithKeyboard}
        />
      </div>
      {headerProfile(!filterUnavailable && !comparisonUnavailable)}
    </th>
  );
}

function columnHeaderControlTarget(target: EventTarget, header: HTMLTableCellElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, details, summary, a, input, select, textarea, [role='button']");
  return control !== null && control !== header;
}
