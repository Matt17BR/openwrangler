import { useLayoutEffect, useMemo, useRef } from "react";
import type { SessionMetadata } from "../../shared/protocol";
import {
  isActiveColumnFilter,
  replaceViewColumnFilter,
  type ColumnFilter,
  type FilterModel
} from "../../shared/filterModel";
import {
  activeFilterColumnLabel,
  activeFilterConditionCount,
  activeFilterValueChoiceCount,
  filterValueLabel,
  predicateLabel,
  selectionValueKey
} from "./filterPresentation";

interface ActiveFilterBarProps {
  metadata: SessionMetadata;
  model: FilterModel;
  disabled?: boolean;
  canUndo: boolean;
  retainVisible?: boolean;
  requestLifecycle?: FilterBarRequestLifecycle;
  onApply(model: FilterModel): string | undefined;
  onUndo(): string | undefined;
}

export interface FilterBarRequestLifecycle {
  pendingRequestId?: string;
  settledRequestId?: string;
}

type FilterFocusAction = { kind: "rule"; index: number } | { kind: "clear" } | { kind: "undo" };

interface FilterFocusIntent {
  requestId: string;
  trigger: HTMLButtonElement;
  action: FilterFocusAction;
}

export function ActiveFilterBar({
  metadata,
  model,
  disabled = false,
  canUndo,
  retainVisible = false,
  requestLifecycle,
  onApply,
  onUndo
}: ActiveFilterBarProps) {
  const region = useRef<HTMLElement | null>(null);
  const focusIntent = useRef<FilterFocusIntent | undefined>(undefined);
  const activeFilters = useMemo(() => model.filters.filter(isActiveColumnFilter), [model.filters]);
  const pendingRequestId = requestLifecycle?.pendingRequestId;
  const settledRequestId = requestLifecycle?.settledRequestId;

  useLayoutEffect(() => {
    const intent = focusIntent.current;
    if (!intent) return;
    if (pendingRequestId !== undefined && pendingRequestId !== intent.requestId) {
      focusIntent.current = undefined;
      return;
    }
    if (pendingRequestId === intent.requestId) {
      if (!ownsPendingFocus(intent, region.current)) {
        focusIntent.current = undefined;
        return;
      }
      if (disabled) region.current?.focus({ preventScroll: true });
      return;
    }
    if (settledRequestId !== intent.requestId) {
      focusIntent.current = undefined;
      return;
    }
    if (!ownsSettledFocus(region.current)) {
      focusIntent.current = undefined;
      return;
    }
    if (disabled) {
      region.current?.focus({ preventScroll: true });
      return;
    }

    focusIntent.current = undefined;
    restoreFilterActionFocus(intent.action, region.current, activeFilters.length > 0);
  }, [activeFilters, canUndo, disabled, pendingRequestId, settledRequestId]);

  if (activeFilters.length === 0 && !canUndo && !retainVisible) return null;

  const applyRuleRemoval = (nextFilter: ColumnFilter, trigger: HTMLButtonElement) => {
    if (disabled) return;
    const buttons = [...(region.current?.querySelectorAll<HTMLButtonElement>("[data-view-filter-rule]") ?? [])];
    const requestId = onApply(replaceViewColumnFilter(model, nextFilter));
    if (requestId) {
      focusIntent.current = {
        requestId,
        trigger,
        action: { kind: "rule", index: Math.max(0, buttons.indexOf(trigger)) }
      };
    }
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
            data-view-filter-clear
            disabled={disabled || activeFilters.length === 0}
            onClick={(event) => {
              const requestId = onApply({ ...model, filters: [] });
              if (requestId) {
                focusIntent.current = { requestId, trigger: event.currentTarget, action: { kind: "clear" } };
              }
            }}
          >
            Clear filters
          </button>
          <button
            type="button"
            className="secondaryButton"
            data-view-filter-undo
            disabled={disabled || !canUndo}
            onClick={(event) => {
              const requestId = onUndo();
              if (requestId) {
                focusIntent.current = { requestId, trigger: event.currentTarget, action: { kind: "undo" } };
              }
            }}
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
            const valueChoiceCount = activeFilterValueChoiceCount(filter);
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

function ownsPendingFocus(intent: FilterFocusIntent, region: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return activeElement === document.body || activeElement === region || activeElement === intent.trigger;
}

function ownsSettledFocus(region: HTMLElement | null): boolean {
  const activeElement = document.activeElement;
  return activeElement === document.body || activeElement === region;
}

function restoreFilterActionFocus(
  action: FilterFocusAction,
  region: HTMLElement | null,
  hasActiveFilters: boolean
): void {
  const ruleButtons = [...(region?.querySelectorAll<HTMLButtonElement>("[data-view-filter-rule]") ?? [])];
  const undo = region?.querySelector<HTMLButtonElement>("[data-view-filter-undo]");
  const clear = region?.querySelector<HTMLButtonElement>("[data-view-filter-clear]");
  if (action.kind === "rule") {
    const target = ruleButtons[Math.min(action.index, Math.max(0, ruleButtons.length - 1))];
    if (focusEnabled(target) || focusEnabled(undo) || focusEnabled(clear)) return;
  } else if (action.kind === "clear") {
    if ((hasActiveFilters && focusEnabled(clear)) || focusEnabled(undo) || focusEnabled(clear)) return;
  } else if (focusEnabled(undo) || focusEnabled(clear)) {
    return;
  }
  focusGridFallback();
}

function focusEnabled(target: HTMLButtonElement | null | undefined): boolean {
  if (!target || target.disabled) return false;
  target.focus({ preventScroll: true });
  return true;
}

function focusGridFallback(): void {
  document
    .querySelector<HTMLElement>('[data-testid="data-grid-scroller"] [data-grid-row][tabindex="0"], main.app')
    ?.focus({ preventScroll: true });
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
