import { useLayoutEffect, useMemo, useRef } from "react";
import type { SessionMetadata } from "../../shared/protocol";
import {
  isActiveColumnFilter,
  replaceViewColumnFilter,
  type ColumnFilter,
  type FilterModel
} from "../../shared/filterModel";
import { activeFilterColumnLabel, filterValueLabel, predicateLabel, selectionValueKey } from "./filterPresentation";

interface ActiveFilterBarProps {
  metadata: SessionMetadata;
  model: FilterModel;
  disabled?: boolean;
  canUndo: boolean;
  retainVisible?: boolean;
  onApply(model: FilterModel): void;
  onUndo(): void;
}

export function ActiveFilterBar({
  metadata,
  model,
  disabled = false,
  canUndo,
  retainVisible = false,
  onApply,
  onUndo
}: ActiveFilterBarProps) {
  const region = useRef<HTMLElement | null>(null);
  const nextFocusIndex = useRef<number | undefined>(undefined);
  const activeFilters = useMemo(() => model.filters.filter(isActiveColumnFilter), [model.filters]);

  useLayoutEffect(() => {
    const requestedIndex = nextFocusIndex.current;
    if (requestedIndex === undefined) return;
    const buttons = [...(region.current?.querySelectorAll<HTMLButtonElement>("[data-view-filter-rule]") ?? [])];
    if (disabled) {
      region.current?.focus();
      return;
    }
    nextFocusIndex.current = undefined;
    const target = buttons[Math.min(requestedIndex, Math.max(0, buttons.length - 1))];
    if (target && !target.disabled) target.focus();
    else {
      const undo = region.current?.querySelector<HTMLButtonElement>("[data-view-filter-undo]");
      if (undo && !undo.disabled) undo.focus();
      else region.current?.focus();
    }
  }, [activeFilters, canUndo, disabled]);

  if (activeFilters.length === 0 && !canUndo && !retainVisible) return null;

  const applyRuleRemoval = (nextFilter: ColumnFilter, trigger: HTMLButtonElement) => {
    if (disabled) return;
    const buttons = [...(region.current?.querySelectorAll<HTMLButtonElement>("[data-view-filter-rule]") ?? [])];
    nextFocusIndex.current = Math.max(0, buttons.indexOf(trigger));
    onApply(replaceViewColumnFilter(model, nextFilter));
  };

  return (
    <section
      ref={region}
      className="viewFilterBar"
      aria-label="Viewing filters"
      aria-busy={disabled || undefined}
      tabIndex={-1}
    >
      <header className="viewFilterBarHeader">
        <div className="viewFilterBarTitle">
          <span className="codicon codicon-filter" aria-hidden="true" />
          <strong>Viewing filters</strong>
          <span className="mutedText" role="status" aria-live="polite" aria-atomic="true">
            {activeFilters.length === 0
              ? "No active filters"
              : `${activeFilters.length} filtered ${activeFilters.length === 1 ? "column" : "columns"}; match ${
                  model.logic === "or" ? "any" : "all"
                }`}
          </span>
        </div>
        <div className="viewFilterBarActions" role="group" aria-label="Viewing filter history">
          <button
            type="button"
            className="compactTextButton"
            disabled={disabled || activeFilters.length === 0}
            onClick={() => onApply({ ...model, filters: [] })}
          >
            Clear filters
          </button>
          <button
            type="button"
            className="secondaryButton"
            data-view-filter-undo
            disabled={disabled || !canUndo}
            onClick={onUndo}
          >
            <span className="codicon codicon-discard" aria-hidden="true" /> Undo latest filter
          </button>
        </div>
      </header>
      {activeFilters.length > 0 && (
        <div className="viewFilterRows" aria-label="Active viewing filter rules">
          {activeFilters.map((filter) => {
            const columnLabel = activeFilterColumnLabel(filter.column, metadata);
            const conditionCount = activeFilterConditionCount(filter);
            const rowLogic = filter.logic === "or" ? "any" : "all";
            const valueChoiceCount = activeValueChoiceCount(filter);
            return (
              <div
                key={filter.column}
                className="viewFilterRow"
                role="group"
                aria-label={`${columnLabel} filters${
                  conditionCount > 1 ? `, match ${rowLogic} conditions within this column` : ""
                }`}
              >
                <span className="viewFilterColumn">
                  <strong>{columnLabel}</strong>
                  <small className="viewFilterType" title={`Semantic type: ${filter.type}`}>
                    {filter.type}
                  </small>
                  {conditionCount > 1 && <small className="viewFilterRowLogic">Match {rowLogic}</small>}
                </span>
                <div className="viewFilterRules">
                  {valueChoiceCount > 0 && (
                    <div
                      className="viewFilterValueGroup"
                      role="group"
                      aria-label={`${columnLabel}: match any selected value`}
                    >
                      {valueChoiceCount > 1 && (
                        <small className="viewFilterValueLogic" title="Match any selected value, null, or NaN">
                          Any value
                        </small>
                      )}
                      {(filter.valueFilter?.selectedValues ?? []).map((value) => {
                        const summary = `equals ${filterValueLabel(value)}`;
                        return (
                          <FilterChip
                            key={`value:${selectionValueKey(value)}`}
                            columnLabel={columnLabel}
                            summary={summary}
                            disabled={disabled}
                            onRemove={(trigger) =>
                              applyRuleRemoval(
                                {
                                  ...filter,
                                  valueFilter: filter.valueFilter
                                    ? {
                                        ...filter.valueFilter,
                                        selectedValues: filter.valueFilter.selectedValues.filter(
                                          (candidate) => selectionValueKey(candidate) !== selectionValueKey(value)
                                        )
                                      }
                                    : undefined
                                },
                                trigger
                              )
                            }
                          />
                        );
                      })}
                      {filter.valueFilter?.includeNulls && (
                        <FilterChip
                          columnLabel={columnLabel}
                          summary="is null"
                          disabled={disabled}
                          onRemove={(trigger) =>
                            applyRuleRemoval(
                              { ...filter, valueFilter: { ...filter.valueFilter!, includeNulls: false } },
                              trigger
                            )
                          }
                        />
                      )}
                      {filter.valueFilter?.includeNaN && (
                        <FilterChip
                          columnLabel={columnLabel}
                          summary="is NaN"
                          disabled={disabled}
                          onRemove={(trigger) =>
                            applyRuleRemoval(
                              { ...filter, valueFilter: { ...filter.valueFilter!, includeNaN: false } },
                              trigger
                            )
                          }
                        />
                      )}
                    </div>
                  )}
                  {filter.predicates.map((predicate, index) => {
                    return (
                      <FilterChip
                        key={`predicate:${predicate.operator}:${index}`}
                        columnLabel={columnLabel}
                        summary={predicateLabel(predicate)}
                        disabled={disabled}
                        onRemove={(trigger) =>
                          applyRuleRemoval(
                            {
                              ...filter,
                              predicates: filter.predicates.filter((_, candidateIndex) => candidateIndex !== index)
                            },
                            trigger
                          )
                        }
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function activeFilterConditionCount(filter: ColumnFilter): number {
  return (activeValueChoiceCount(filter) > 0 ? 1 : 0) + filter.predicates.length;
}

function activeValueChoiceCount(filter: ColumnFilter): number {
  return (
    (filter.valueFilter?.selectedValues.length ?? 0) +
    (filter.valueFilter?.includeNulls ? 1 : 0) +
    (filter.valueFilter?.includeNaN ? 1 : 0)
  );
}

function FilterChip({
  columnLabel,
  summary,
  disabled,
  onRemove
}: {
  columnLabel: string;
  summary: string;
  disabled: boolean;
  onRemove(trigger: HTMLButtonElement): void;
}) {
  return (
    <button
      type="button"
      className="rulePill rulePillButton viewFilterChip"
      data-view-filter-rule
      disabled={disabled}
      aria-label={`Remove ${summary} filter from ${columnLabel}`}
      title={`Remove ${summary} filter from ${columnLabel}`}
      onClick={(event) => onRemove(event.currentTarget)}
    >
      <span>{summary}</span>
      <span className="codicon codicon-close" aria-hidden="true" />
    </button>
  );
}
