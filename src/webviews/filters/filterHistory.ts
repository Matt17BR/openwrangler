import { compactFilterModel, type ColumnFilter, type FilterModel } from "../../shared/filterModel";

export const MAX_CONFIRMED_FILTER_HISTORY = 20;

export interface ConfirmedFilterState {
  logic?: FilterModel["logic"];
  filters: ColumnFilter[];
}

export interface ConfirmedFilterHistory {
  entries: ConfirmedFilterState[];
}

export interface FilterHistoryUndoRequest {
  model: FilterModel;
  target: ConfirmedFilterState;
}

export const emptyConfirmedFilterHistory = (): ConfirmedFilterHistory => ({ entries: [] });

export const confirmedFilterState = (model: FilterModel): ConfirmedFilterState => {
  const compact = compactFilterModel(model);
  return cloneFilterState({
    ...(compact.logic === undefined ? {} : { logic: compact.logic }),
    filters: compact.filters
  });
};

export const sameConfirmedFilters = (
  left: Pick<FilterModel, "logic" | "filters">,
  right: Pick<FilterModel, "logic" | "filters">
): boolean =>
  JSON.stringify({ logic: left.logic ?? "and", filters: left.filters }) ===
  JSON.stringify({ logic: right.logic ?? "and", filters: right.filters });

/**
 * Record only a transition between two runtime-confirmed filter states. Sorts
 * deliberately do not participate in this history.
 */
export const recordConfirmedFilterTransition = (
  history: ConfirmedFilterHistory,
  previous: FilterModel,
  next: FilterModel,
  limit = MAX_CONFIRMED_FILTER_HISTORY
): ConfirmedFilterHistory => {
  if (sameConfirmedFilters(previous, next)) return history;
  const boundedLimit = Math.max(1, Math.floor(limit));
  return {
    entries: [...history.entries, confirmedFilterState(previous)].slice(-boundedLimit)
  };
};

/** Build an undo request from confirmed history while retaining live sorts. */
export const latestConfirmedFilterUndo = (
  history: ConfirmedFilterHistory,
  current: FilterModel
): FilterHistoryUndoRequest | undefined => {
  const latest = history.entries.at(-1);
  if (!latest) return undefined;
  const target = cloneFilterState(latest);
  return {
    target,
    model: {
      ...(target.logic === undefined ? {} : { logic: target.logic }),
      filters: cloneFilterState(target).filters,
      sort: current.sort
    }
  };
};

/**
 * Consume one history entry only after its correlated runtime response
 * confirms the requested state. An unexpected authoritative result clears the
 * local stack instead of offering an undo target the runtime did not accept.
 */
export const confirmLatestFilterUndo = (
  history: ConfirmedFilterHistory,
  requestedTarget: ConfirmedFilterState,
  confirmed: FilterModel
): ConfirmedFilterHistory => {
  const latest = history.entries.at(-1);
  if (!latest || !sameConfirmedFilters(latest, requestedTarget)) return history;
  if (!sameConfirmedFilters(requestedTarget, confirmed)) return emptyConfirmedFilterHistory();
  return { entries: history.entries.slice(0, -1) };
};

function cloneFilterState<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneFilterState(item)) as T;
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) clone[key] = cloneFilterState(item);
    return clone as T;
  }
  return value;
}
