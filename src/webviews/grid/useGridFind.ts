import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isFindQuery, type FindOptions } from "../../shared/find";
import type { ColumnSchema, FindRequest, GridCell, OpenWranglerResponse } from "../../shared/protocol";

export type GridFindQuery = Omit<FindRequest, "kind" | "sessionId" | "revision" | "viewRequestId" | "filterModel">;
export type GridFindSettlement = Extract<OpenWranglerResponse, { kind: "cellsFound" | "error" | "cancelled" }>;
export type GridFindDirection = FindRequest["direction"];

export interface GridFindRequest {
  /** "replace" also opens the Replace row; "advance" moves past the focused cell once a Replace preview arrives. */
  action: "open" | "replace" | "advance" | GridFindDirection;
  requestId: number;
}

/** Whether the host can replace matches now, or how to make it possible. */
export type GridReplaceAvailability =
  | { kind: "ready"; busy: boolean }
  | { kind: "switch"; busy: boolean; switchToEditing(trigger: HTMLButtonElement): void }
  | { kind: "unavailable"; reason: string };

export interface GridReplaceRequest {
  criteria: GridFindCriteria;
  replacement: string;
  /** The current match's column and zero-based dataframe row; absent to replace every match in scope. */
  cell?: { columnId: string; position: number };
}

/** Ctrl+H, or Cmd+Option+F as on macOS, opens Replace like the editor's find widget. */
export function isReplaceShortcut(event: {
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  key: string;
  code: string;
}): boolean {
  if (event.shiftKey) return false;
  if (event.ctrlKey && !event.metaKey && !event.altKey) return event.key.toLowerCase() === "h";
  // Option composes a character on macOS, so match the physical key.
  return event.metaKey && !event.ctrlKey && event.altKey && event.code === "KeyF";
}

export type GridFindStatus =
  | { kind: "idle" }
  | { kind: "pending"; includeFrom: boolean }
  | { kind: "found"; ordinal: number; count: number; cell: GridCell; position?: number }
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
  /** Whether the session can replace cells, which needs each match's dataframe row. */
  replaceable: boolean;
  findCells(query: GridFindQuery): Promise<GridFindSettlement>;
  onReplace(request: GridReplaceRequest): void;
  origin(): GridCell | undefined;
  defaultScope(): string | undefined;
  reveal(cell: GridCell): void;
  returnFocus(): void;
}

export function useGridFind({
  viewKey,
  searchableColumnIds,
  unavailableReason,
  replaceable,
  findCells,
  onReplace,
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
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replacement, setReplacement] = useState("");
  const [replaceFocusRequestId, setReplaceFocusRequestId] = useState(0);
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
        ...(from === undefined ? {} : { from, includeFrom }),
        ...(replaceOpen && replaceable ? { includePosition: true } : {})
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
                    cell: { row: settlement.match.row, columnId: settlement.match.columnId },
                    ...(settlement.match.position === undefined ? {} : { position: settlement.match.position })
                  }
                : { kind: "none" };
        setResult({ viewKey, criteria: next, status });
        if (status.kind === "found") latestReveal.current(status.cell);
      });
    },
    [cancelTyping, findCells, origin, replaceOpen, replaceable, unavailableReason, viewKey]
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
      if (action === "advance") {
        if (open && isFindQuery(next.text)) search(next, "next", false);
        return;
      }
      if (action === "replace") {
        setReplaceOpen(true);
        if (isFindQuery(next.text)) setReplaceFocusRequestId((current) => current + 1);
        else setFocusRequestId((current) => current + 1);
        return;
      }
      setFocusRequestId((current) => current + 1);
      if (action === "open" || !isFindQuery(next.text)) return;
      search(next, action, open && includeFocusedCell);
    },
    [criteria, defaultScope, includeFocusedCell, open, search, searchableColumnIds]
  );

  // Replacing one cell needs the match's dataframe row, which searches report only while the Replace row is open.
  const unpositionedMatch =
    open && replaceOpen && replaceable && status.kind === "found" && status.position === undefined
      ? `${viewKey}\u0000${status.cell.row}\u0000${status.cell.columnId}`
      : undefined;
  const positionRequested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (unpositionedMatch === undefined || positionRequested.current === unpositionedMatch) return;
    positionRequested.current = unpositionedMatch;
    search(criteria, "next", true);
  }, [criteria, search, unpositionedMatch]);

  const toggleReplace = useCallback(() => setReplaceOpen((current) => !current), []);

  const matchPosition = status.kind === "found" ? status.position : undefined;
  const matchColumnId = status.kind === "found" ? status.cell.columnId : undefined;
  const replace = useCallback(
    (all: boolean) => {
      if (!replaceable || unavailableReason || !isFindQuery(criteria.text)) return;
      if (all) onReplace({ criteria, replacement });
      else if (matchColumnId !== undefined && matchPosition !== undefined)
        onReplace({ criteria, replacement, cell: { columnId: matchColumnId, position: matchPosition } });
    },
    [criteria, matchColumnId, matchPosition, onReplace, replaceable, replacement, unavailableReason]
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
    changeOptions,
    replaceOpen,
    replacement,
    replaceFocusRequestId,
    toggleReplace,
    changeReplacement: setReplacement,
    replace
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
