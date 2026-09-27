import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isFindQuery, type FindOptions } from "../../shared/find";
import type { ColumnSchema, FindRequest, GridCell, OpenWranglerResponse } from "../../shared/protocol";

export type GridFindQuery = Omit<FindRequest, "kind" | "sessionId" | "revision" | "viewRequestId" | "filterModel">;
export type GridFindSettlement = Extract<OpenWranglerResponse, { kind: "cellsFound" | "error" | "cancelled" }>;
export type GridFindDirection = FindRequest["direction"];

export interface GridFindRequest {
  action: "open" | GridFindDirection;
  requestId: number;
}

export type GridFindStatus =
  | { kind: "idle" }
  | { kind: "pending"; includeFrom: boolean }
  | { kind: "found"; ordinal: number; count: number; cell: GridCell }
  | { kind: "none" }
  | { kind: "error"; message: string };

export interface GridFindCriteria extends FindOptions {
  /** One column ID, or undefined for every column. */
  scope: string | undefined;
}

export interface GridFindHighlight extends FindOptions {
  columnId: string | undefined;
  current: GridCell | undefined;
}

interface GridFindResult {
  viewKey: string;
  criteria: GridFindCriteria;
  status: GridFindStatus;
}

export const FIND_TYPING_DELAY_MS = 250;

export function isFindableColumn(column: ColumnSchema): boolean {
  return column.type !== "list" && column.type !== "struct";
}
const idle: GridFindStatus = { kind: "idle" };

interface UseGridFindOptions {
  /** Changes whenever the rows, their order or the schema change, which invalidates match positions. */
  viewKey: string;
  /** Columns that Find can scope to; a scope outside this set searches every column. */
  searchableColumnIds: ReadonlySet<string>;
  unavailableReason: string | undefined;
  findCells(query: GridFindQuery): Promise<GridFindSettlement>;
  origin(): GridCell | undefined;
  defaultScope(): string | undefined;
  reveal(cell: GridCell): void;
  returnFocus(): void;
}

export function useGridFind({
  viewKey,
  searchableColumnIds,
  unavailableReason,
  findCells,
  origin,
  defaultScope,
  reveal,
  returnFocus
}: UseGridFindOptions) {
  const [open, setOpen] = useState(false);
  const [requestedCriteria, setCriteria] = useState<GridFindCriteria>({
    text: "",
    matchCase: false,
    wholeCell: false,
    scope: undefined
  });
  const criteria = useMemo(
    () => withSearchableScope(requestedCriteria, searchableColumnIds),
    [requestedCriteria, searchableColumnIds]
  );
  const [result, setResult] = useState<GridFindResult | undefined>();
  const [focusRequestId, setFocusRequestId] = useState(0);
  const sequence = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const currentViewKey = useRef(viewKey);
  const latestReveal = useRef(reveal);

  useLayoutEffect(() => {
    latestReveal.current = reveal;
  });

  const cancelTyping = useCallback(() => {
    if (typingTimer.current !== undefined) window.clearTimeout(typingTimer.current);
    typingTimer.current = undefined;
  }, []);

  useLayoutEffect(() => {
    currentViewKey.current = viewKey;
    sequence.current += 1;
    cancelTyping();
  }, [cancelTyping, viewKey]);

  useEffect(() => cancelTyping, [cancelTyping]);

  const search = useCallback(
    (next: GridFindCriteria, direction: GridFindDirection, includeFrom: boolean) => {
      cancelTyping();
      sequence.current += 1;
      const token = sequence.current;
      if (unavailableReason || !isFindQuery(next.text)) {
        setResult(undefined);
        return;
      }
      const from = origin();
      setResult({ viewKey, criteria: next, status: { kind: "pending", includeFrom } });
      void findCells({
        query: next.text,
        matchCase: next.matchCase,
        wholeCell: next.wholeCell,
        direction,
        ...(next.scope === undefined ? {} : { columnIds: [next.scope] }),
        ...(from === undefined ? {} : { from, includeFrom })
      }).then((settlement) => {
        if (token !== sequence.current || currentViewKey.current !== viewKey) return;
        const status: GridFindStatus =
          settlement.kind === "error"
            ? { kind: "error", message: settlement.message }
            : settlement.kind === "cancelled"
              ? idle
              : settlement.match
                ? {
                    kind: "found",
                    ordinal: settlement.match.ordinal,
                    count: settlement.matchCount,
                    cell: { row: settlement.match.row, columnId: settlement.match.columnId }
                  }
                : { kind: "none" };
        setResult({ viewKey, criteria: next, status });
        if (status.kind === "found") latestReveal.current(status.cell);
      });
    },
    [cancelTyping, findCells, origin, unavailableReason, viewKey]
  );

  const status = result && result.viewKey === viewKey && sameCriteria(result.criteria, criteria) ? result.status : idle;

  // A settled search moves past the focused cell; a new search may match it. An in-flight search keeps its choice.
  const includeFocusedCell =
    status.kind === "pending" ? status.includeFrom : status.kind !== "found" && status.kind !== "none";

  const step = useCallback(
    (direction: GridFindDirection) => search(criteria, direction, includeFocusedCell),
    [criteria, includeFocusedCell, search]
  );

  const changeText = useCallback(
    (text: string) => {
      const next = { ...criteria, text };
      setCriteria(next);
      cancelTyping();
      sequence.current += 1;
      if (!isFindQuery(text)) {
        setResult(undefined);
        return;
      }
      typingTimer.current = window.setTimeout(() => {
        typingTimer.current = undefined;
        search(next, "next", true);
      }, FIND_TYPING_DELAY_MS);
    },
    [cancelTyping, criteria, search]
  );

  const changeOptions = useCallback(
    (patch: Partial<Omit<GridFindCriteria, "text">>) => {
      const next = withSearchableScope({ ...criteria, ...patch }, searchableColumnIds);
      setCriteria(next);
      if (isFindQuery(next.text)) search(next, "next", true);
    },
    [criteria, search, searchableColumnIds]
  );

  /** Opens or refocuses the bar; a direction also searches, starting after the focused cell when the bar was closed. */
  const request = useCallback(
    (action: GridFindRequest["action"]) => {
      let next = criteria;
      if (!open) {
        next = withSearchableScope({ ...criteria, scope: defaultScope() }, searchableColumnIds);
        setCriteria(next);
        setOpen(true);
      }
      setFocusRequestId((current) => current + 1);
      if (action === "open" || !isFindQuery(next.text)) return;
      search(next, action, open && includeFocusedCell);
    },
    [criteria, defaultScope, includeFocusedCell, open, search, searchableColumnIds]
  );

  const close = useCallback(() => {
    cancelTyping();
    sequence.current += 1;
    setOpen(false);
    setResult(undefined);
    returnFocus();
  }, [cancelTyping, returnFocus]);

  const current = status.kind === "found" ? status.cell : undefined;
  const highlight = useMemo<GridFindHighlight | undefined>(
    () =>
      open && isFindQuery(criteria.text)
        ? {
            text: criteria.text,
            matchCase: criteria.matchCase,
            wholeCell: criteria.wholeCell,
            columnId: criteria.scope,
            current
          }
        : undefined,
    [criteria, current, open]
  );

  return {
    open,
    criteria,
    status,
    focusRequestId,
    unavailableReason,
    highlight,
    request,
    close,
    step,
    changeText,
    changeOptions
  };
}

export type GridFindController = ReturnType<typeof useGridFind>;

function withSearchableScope(criteria: GridFindCriteria, searchable: ReadonlySet<string>): GridFindCriteria {
  return criteria.scope === undefined || searchable.has(criteria.scope) ? criteria : { ...criteria, scope: undefined };
}

function sameCriteria(left: GridFindCriteria, right: GridFindCriteria): boolean {
  return (
    left.text === right.text &&
    left.matchCase === right.matchCase &&
    left.wholeCell === right.wholeCell &&
    left.scope === right.scope
  );
}
