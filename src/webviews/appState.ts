import type {
  ColumnSummary,
  ColumnSchema,
  DataDiff,
  GridPage,
  LiveGridPage,
  OperationKind,
  SessionMetadata,
  ValuesResponse
} from "../shared/protocol";
import type { FilterModel } from "../shared/filterModel";
import { operationKinds } from "../shared/operationCatalog.generated";
import { isColumnSchemaArray, isDataDiff, isOpenWranglerResponse } from "../shared/protocolValidation";
import { SESSION_OPEN_PROGRESS_STAGES, type SessionOpenProgressStage } from "../shared/sessionOpenProgress";
import { decodeGridViewState } from "../shared/viewState";
import type { ConfirmedFilterState } from "./filters/filterHistory";
import type { VisibleColumnRange } from "./grid/DataGrid";

export type NonSortEditorAction =
  | "openOperation"
  | "editLatest"
  | "editStep"
  | "deleteStep"
  | "selectStep"
  | "clearFilterColumn"
  | "openFilters"
  | "applyDraft"
  | "discardDraft"
  | "undoStep";

type ViewSortEditorActionMessage = {
  kind: "editorAction";
  action: "changeViewSort";
  column: string;
  sortAction: "moveUp" | "moveDown" | "remove";
  expectedSessionId: string;
  expectedSortModelSignature: string;
  expectedSortIndex: number;
};

type StepEditorActionMessage = {
  kind: "editorAction";
  action: "editStep" | "deleteStep";
  stepId: string;
  expectedSessionId: string;
  expectedRevision: number;
};

type OtherEditorActionMessage = {
  kind: "editorAction";
  action: Exclude<NonSortEditorAction, StepEditorActionMessage["action"]>;
  expectedSessionId?: string;
  expectedRevision?: number;
  operationKind?: OperationKind;
  stepId?: string;
  column?: string;
};

export type EditorActionMessage = ViewSortEditorActionMessage | StepEditorActionMessage | OtherEditorActionMessage;

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

export type OperationIntent =
  { action: "open"; operationKind?: OperationKind } | { action: "editLatest" } | { action: "editStep"; stepId: string };

export type QueuedOperationIntent = OperationIntent & {
  sessionId: string;
  revision: number;
};

export interface RendererSynchronizationMessage {
  kind: "rendererSynchronization";
  syncId: string;
  sessionId: string | null;
  revision: number | null;
  layoutTransitionPending: boolean;
}

type SessionPresentationMessage = {
  kind: "sessionPresentation";
  presentation: {
    sessionId: string;
    revision: number;
    draft?: {
      diff: DataDiff;
      remainingMissingCells?: number;
      warnings: string[];
      beforeSchema: ColumnSchema[];
    };
  };
};

export function decodeAppHostMessage(value: unknown) {
  if (isOpenWranglerResponse(value)) return value;
  if (!isRecord(value)) return undefined;

  switch (value.kind) {
    case "sessionOpenProgress":
      return value.stage === null || isSessionOpenProgressStage(value.stage)
        ? { kind: value.kind, stage: value.stage }
        : undefined;
    case "rendererSynchronization":
      return typeof value.syncId === "string" &&
        ((value.sessionId === null && value.revision === null) ||
          (typeof value.sessionId === "string" && isNonNegativeInteger(value.revision))) &&
        typeof value.layoutTransitionPending === "boolean"
        ? {
            kind: value.kind,
            syncId: value.syncId,
            sessionId: value.sessionId,
            revision: value.revision,
            layoutTransitionPending: value.layoutTransitionPending
          }
        : undefined;
    case "requestImportOptionsChange":
      return typeof value.actionId === "string" ? { kind: value.kind, actionId: value.actionId } : undefined;
    case "importOptionsState":
    case "runtimeDependencyInstallState":
      return typeof value.busy === "boolean" ? { kind: value.kind, busy: value.busy } : undefined;
    case "sessionModeChangeState":
      return typeof value.busy === "boolean" && (value.mode === "viewing" || value.mode === "editing")
        ? { kind: value.kind, busy: value.busy, mode: value.mode as "viewing" | "editing" }
        : undefined;
    case "sessionPresentation": {
      const presentation = value.presentation;
      if (
        !isRecord(presentation) ||
        typeof presentation.sessionId !== "string" ||
        !isNonNegativeInteger(presentation.revision)
      )
        return undefined;
      if (presentation.draft === undefined) return value as SessionPresentationMessage;
      const draft = presentation.draft;
      return isRecord(draft) &&
        isDataDiff(draft.diff) &&
        (draft.remainingMissingCells === undefined || isNonNegativeInteger(draft.remainingMissingCells)) &&
        isStringArray(draft.warnings) &&
        isColumnSchemaArray(draft.beforeSchema)
        ? (value as SessionPresentationMessage)
        : undefined;
    }
    case "viewState": {
      const state = decodeGridViewState(value.state);
      return state ? { kind: value.kind, state } : undefined;
    }
    case "stepInspectionResult": {
      const response = value.response;
      return typeof value.stepId === "string" &&
        isNonNegativeInteger(value.offset) &&
        isNonNegativeInteger(value.limit) &&
        value.limit > 0 &&
        isNonNegativeInteger(value.columnOffset) &&
        isNonNegativeInteger(value.columnLimit) &&
        value.columnLimit > 0 &&
        isOpenWranglerResponse(response) &&
        (response.kind === "error" || response.kind === "cancelled" || response.kind === "stepInspection")
        ? {
            kind: value.kind,
            stepId: value.stepId,
            offset: value.offset,
            limit: value.limit,
            columnOffset: value.columnOffset,
            columnLimit: value.columnLimit,
            response
          }
        : undefined;
    }
    case "stepInspectionCleared":
      return typeof value.resumeProfiling === "boolean"
        ? { kind: value.kind, resumeProfiling: value.resumeProfiling }
        : undefined;
    case "editorAction":
      if (
        typeof value.action !== "string" ||
        (value.expectedSessionId !== undefined && typeof value.expectedSessionId !== "string") ||
        (value.expectedRevision !== undefined && !isNonNegativeInteger(value.expectedRevision)) ||
        (value.stepId !== undefined && typeof value.stepId !== "string") ||
        (value.column !== undefined && typeof value.column !== "string")
      )
        return undefined;
      switch (value.action) {
        case "openOperation":
          return value.operationKind === undefined || operationKinds.some((kind) => kind === value.operationKind)
            ? (value as OtherEditorActionMessage)
            : undefined;
        case "editStep":
        case "deleteStep":
          return typeof value.stepId === "string" &&
            typeof value.expectedSessionId === "string" &&
            isNonNegativeInteger(value.expectedRevision)
            ? (value as StepEditorActionMessage)
            : undefined;
        case "editLatest":
        case "selectStep":
        case "clearFilterColumn":
        case "openFilters":
        case "applyDraft":
        case "discardDraft":
        case "undoStep":
          return value as OtherEditorActionMessage;
        case "changeViewSort":
          return (value.sortAction === "moveUp" || value.sortAction === "moveDown" || value.sortAction === "remove") &&
            typeof value.expectedSessionId === "string" &&
            typeof value.expectedSortModelSignature === "string" &&
            isNonNegativeInteger(value.expectedSortIndex) &&
            typeof value.column === "string"
            ? (value as ViewSortEditorActionMessage)
            : undefined;
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
