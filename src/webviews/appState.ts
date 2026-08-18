import type {
  ColumnSummary,
  ColumnSchema,
  DataDiff,
  OpenWranglerResponse,
  GridPage,
  LiveGridPage,
  OperationKind,
  SessionMetadata,
  SessionMode,
  ValuesResponse
} from "../shared/protocol";
import type { FilterModel } from "../shared/filterModel";
import { SESSION_OPEN_PROGRESS_STAGES, type SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import type { ConfirmedFilterState } from "./filters/filterHistory";
import type { VisibleColumnRange } from "./grid/DataGrid";

export type NonSortEditorAction =
  | "openOperation"
  | "editLatest"
  | "selectStep"
  | "clearFilterColumn"
  | "openFilters"
  | "applyDraft"
  | "discardDraft"
  | "undoStep";

export type EditorActionMessage =
  | {
      kind: "editorAction";
      action: "changeViewSort";
      column: string;
      sortAction: "moveUp" | "moveDown" | "remove";
      expectedSessionId: string;
      expectedSortModelSignature: string;
      expectedSortIndex: number;
    }
  | {
      kind: "editorAction";
      action: NonSortEditorAction;
      expectedSessionId?: string;
      expectedRevision?: number;
      operationKind?: OperationKind;
      stepId?: string;
      column?: string;
    };

export interface ViewSortActionTarget {
  column: string;
  action: "moveUp" | "moveDown" | "remove";
  expectedSessionId: string;
  expectedSortModelSignature: string;
  expectedSortIndex: number;
}

export interface QueuedStepSelection {
  sessionId: string;
  revision: number;
  stepId?: string;
}

export type OperationIntent = { action: "open"; operationKind?: OperationKind } | { action: "editLatest" };

export type QueuedOperationIntent = OperationIntent & {
  sessionId: string;
  revision: number;
};

export interface RequestImportOptionsChangeMessage {
  kind: "requestImportOptionsChange";
  actionId: string;
}

export interface RendererSynchronizationMessage {
  kind: "rendererSynchronization";
  syncId: string;
  sessionId: string | null;
  revision: number | null;
  layoutTransitionPending: boolean;
}

export interface ImportOptionsStateMessage {
  kind: "importOptionsState";
  busy: boolean;
}

export interface RuntimeDependencyInstallStateMessage {
  kind: "runtimeDependencyInstallState";
  busy: boolean;
}

export interface SessionModeChangeStateMessage {
  kind: "sessionModeChangeState";
  busy: boolean;
  mode: SessionMode;
}

export interface SessionOpenProgressMessage {
  kind: "sessionOpenProgress";
  stage: unknown;
}

export interface SessionPresentationMessage {
  kind: "sessionPresentation";
  presentation: {
    sessionId: string;
    revision: number;
    code: string;
    draft?: {
      diff: DataDiff;
      remainingMissingCells?: number;
      warnings: string[];
      beforeSchema: ColumnSchema[];
    };
  };
}

export interface ViewStateMessage {
  kind: "viewState";
  state: unknown;
}

export interface StepInspectionResultMessage {
  kind: "stepInspectionResult";
  stepId: string;
  offset: number;
  limit: number;
  columnOffset: number;
  columnLimit: number;
  response: OpenWranglerResponse;
}

export interface StepInspectionClearedMessage {
  kind: "stepInspectionCleared";
  resumeProfiling: boolean;
}

export interface ConfirmedView {
  viewContextId: string;
  sessionId: string;
  revision: number;
}

export interface ConfirmedViewState {
  view: ConfirmedView;
  metadata: SessionMetadata;
  page: LiveGridPage;
  columnWindow: ColumnWindow;
  summaries: ColumnSummary[];
  columnValues: ReadonlyMap<string, ValuesResponse>;
  backgroundDiagnostics: ReadonlyMap<string, BackgroundDiagnostic>;
}

export interface PendingStepInspection {
  stepId: string;
  offset: number;
  columnWindow: ColumnWindow;
  reason: "selection" | "row" | "projection";
}

export interface DiffBeforeState {
  schema: ColumnSchema[];
  page?: GridPage;
}

export interface PendingPageRequest {
  viewRequestId: string;
  viewContextId: string;
  changesView: boolean;
  offset: number;
  model: FilterModel;
  columnWindow: ColumnWindow;
  reason: PageRequestReason;
  previousConfirmedState?: ConfirmedViewState;
  filterHistoryUndoTarget?: ConfirmedFilterState;
}

export interface ColumnWindow {
  offset: number;
  limit: number;
}

export interface ColumnRevealSynchronization {
  sessionId: string;
  revision: number;
}

export interface ColumnRevealRequest {
  columnId: string;
  requestId: number;
  retainUntilSynchronization?: ColumnRevealSynchronization;
}

export type PageRequestReason = "view" | "row" | "projection";

export type SummaryRequestOwner = "grid" | "drawer";

export type PendingBackgroundRequest =
  | {
      kind: "summary";
      viewContextId: string;
      columnId: string;
      attempt: number;
      owners: Set<SummaryRequestOwner>;
    }
  | { kind: "stats"; viewContextId: string; attempt: number }
  | { kind: "values"; viewContextId: string; column: string };

export interface BackgroundDiagnostic {
  message: string;
  pending: PendingBackgroundRequest;
}

export interface PageRequestOptions {
  changesView?: boolean;
  viewContextId?: string;
  columnWindow?: ColumnWindow;
  reason?: PageRequestReason;
  filterHistoryUndoTarget?: ConfirmedFilterState;
}

export interface ApplyFilterOptions {
  filterHistoryUndoTarget?: ConfirmedFilterState;
}

export function backgroundDiagnosticKey(pending: PendingBackgroundRequest): string {
  if (pending.kind === "stats") return "stats";
  return `${pending.kind}:${pending.kind === "summary" ? pending.columnId : pending.column}`;
}

export function cloneBackgroundDiagnostics(
  diagnostics: ReadonlyMap<string, BackgroundDiagnostic>
): ReadonlyMap<string, BackgroundDiagnostic> {
  return new Map(
    [...diagnostics].map(([key, diagnostic]) => [
      key,
      {
        ...diagnostic,
        pending:
          diagnostic.pending.kind === "summary"
            ? { ...diagnostic.pending, owners: new Set(diagnostic.pending.owners) }
            : { ...diagnostic.pending }
      }
    ])
  );
}

export function withoutDatasetStats(metadata: SessionMetadata): SessionMetadata {
  const { stats: _stats, ...rest } = metadata;
  return rest;
}

export function sameFilterModel(left: FilterModel, right: FilterModel): boolean {
  return filterModelScope(left) === filterModelScope(right);
}

export function sameFilterRules(left: FilterModel, right: FilterModel): boolean {
  return (
    JSON.stringify({ logic: left.logic ?? "and", filters: left.filters }) ===
    JSON.stringify({ logic: right.logic ?? "and", filters: right.filters })
  );
}

export function sameSortRules(left: FilterModel, right: FilterModel): boolean {
  return JSON.stringify(left.sort) === JSON.stringify(right.sort);
}

export function filterModelForColumnValues(model: FilterModel, column: string): FilterModel {
  return {
    ...model,
    filters: model.filters.filter((filter) => filter.column !== column)
  };
}

export function isSwitchableFileBackend(backend: SessionMetadata["backend"]): boolean {
  return backend === "pandas" || backend === "polars" || backend === "duckdb";
}

function filterModelScope(model: FilterModel): string {
  return JSON.stringify({ logic: model.logic ?? "and", filters: model.filters, sort: model.sort });
}

export function alignedColumnWindow(range: VisibleColumnRange, totalColumns: number, blockSize: number): ColumnWindow {
  const boundedBlockSize = Math.max(1, Math.min(256, Math.floor(blockSize)));
  if (totalColumns <= 0) return { offset: 0, limit: boundedBlockSize };
  const start = Math.max(0, Math.min(Math.floor(range.start), totalColumns - 1));
  const end = Math.max(start + 1, Math.min(Math.ceil(range.end), totalColumns));
  const offset = Math.floor(start / boundedBlockSize) * boundedBlockSize;
  const alignedEnd = Math.min(totalColumns, Math.ceil(end / boundedBlockSize) * boundedBlockSize);
  if (alignedEnd - offset <= 256) return { offset, limit: Math.max(1, alignedEnd - offset) };

  const shiftedOffset = Math.min(start, Math.max(0, totalColumns - 256));
  return { offset: shiftedOffset, limit: Math.max(1, Math.min(256, totalColumns - shiftedOffset)) };
}

export function columnWindowFromPage(
  metadata: SessionMetadata,
  page: LiveGridPage,
  fallback: ColumnWindow
): ColumnWindow {
  if (!metadata.schema.length) return { offset: 0, limit: Math.max(1, fallback.limit) };
  const firstId = page.columnIds[0];
  const firstPosition = firstId === undefined ? -1 : metadata.schema.findIndex((column) => column.id === firstId);
  if (firstPosition < 0 || page.columnIds.length === 0) {
    return {
      offset: Math.max(0, Math.min(fallback.offset, metadata.schema.length - 1)),
      limit: Math.max(1, Math.min(256, fallback.limit))
    };
  }
  return { offset: firstPosition, limit: Math.max(1, Math.min(256, page.columnIds.length)) };
}

export function sessionOpenProgressHeading(stage: SessionOpenProgressStage): string {
  switch (stage) {
    case "acquiringKernel":
      return "Connecting to the notebook kernel…";
    case "bootstrappingRuntime":
      return "Preparing Open Wrangler in the kernel…";
    case "openingNotebookVariable":
      return "Opening the live notebook variable…";
    case "preparingSparkView":
      return "Preparing PySpark 4.2 (viewing only)…";
  }
}

export function isSessionOpenProgressStage(value: unknown): value is SessionOpenProgressStage {
  return typeof value === "string" && (SESSION_OPEN_PROGRESS_STAGES as readonly string[]).includes(value);
}

export function pageCoversColumnWindow(metadata: SessionMetadata, page: LiveGridPage, window: ColumnWindow): boolean {
  if (!metadata.schema.length) return page.columnIds.length === 0;
  const expectedIds = metadata.schema
    .slice(window.offset, Math.min(metadata.schema.length, window.offset + window.limit))
    .map((column) => column.id);
  if (!expectedIds.length) return false;
  const first = page.columnIds.indexOf(expectedIds[0]);
  return (
    first >= 0 &&
    first + expectedIds.length <= page.columnIds.length &&
    expectedIds.every((columnId, index) => page.columnIds[first + index] === columnId)
  );
}
