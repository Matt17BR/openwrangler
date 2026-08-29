import { supportsOperation } from "../shared/operations";
import type { OpenWranglerRequest, SessionMode, SessionOpenedResponse } from "../shared/protocol";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState } from "../shared/viewState";
import { isWebviewFailurePhase, type WebviewFailurePhase } from "../shared/webviewFailure";

export interface WebviewMessageDecodeContext {
  sessionId: string | undefined;
  sessionRevision: number;
  snapshot: Pick<SessionOpenedResponse, "metadata"> | undefined;
}

export type WebviewRequest =
  | { kind: "ready" }
  | { kind: "webviewFailure"; phase: WebviewFailurePhase }
  | { kind: "requestSessionSnapshot" }
  | {
      kind: "rendererSynchronized";
      syncId: string;
      sessionId: string | null;
      revision: number | null;
    }
  | {
      kind: "rendererRetiring";
      syncId: string;
      sessionId: string | null;
      revision: number | null;
    }
  | { kind: "setViewContext"; viewContextId: string }
  | { kind: "cancelViewRequests"; viewRequestIds: string[] }
  | { kind: "prioritizeViewRequest"; viewRequestId: string }
  | { kind: "updateViewState"; state: GridViewState }
  | { kind: "clearStepInspection" }
  | {
      kind: "rewriteCleaningPlan";
      action: "applyDraft" | "deleteStep";
      stepId: string;
      offset: number;
      limit: number;
      columnOffset: number;
      columnLimit: number;
    }
  | { kind: "changeImportOptions"; actionId?: string }
  | { kind: "changeBackend" }
  | { kind: "installRuntimeDependencies" }
  | { kind: "exportData" }
  | { kind: "switchSessionMode"; mode: SessionMode; state: GridViewState }
  | { kind: "reconnectLiveSource" }
  | {
      kind: "runtimeRequest";
      request: OpenWranglerRequest;
      viewContextId?: string;
      priority?: "interactive" | "background";
      purpose?: "clipboardColumn";
    };

const WEBVIEW_RUNTIME_REQUEST_KINDS = new Set<OpenWranglerRequest["kind"]>([
  "getPage",
  "getSummary",
  "getDatasetStats",
  "getColumnValues",
  "inspectStep",
  "previewStep",
  "applyDraft",
  "discardDraft",
  "undoStep"
]);
const MAX_WEBVIEW_VIEW_ID_CODE_UNITS = 256;
const MAX_CANCEL_VIEW_REQUEST_IDS = 1_024;
const MAX_CANCEL_VIEW_REQUEST_ID_CODE_UNITS = 64 * 1_024;

export function decodeWebviewMessage(
  message: unknown,
  context: WebviewMessageDecodeContext
): WebviewRequest | undefined {
  if (!isRecord(message) || typeof message.kind !== "string") return undefined;
  if (message.kind === "ready") {
    return hasExactKeys(message, ["kind"]) ? { kind: "ready" } : undefined;
  }
  if (message.kind === "webviewFailure") {
    return hasExactKeys(message, ["kind", "phase"]) && isWebviewFailurePhase(message.phase)
      ? { kind: "webviewFailure", phase: message.phase }
      : undefined;
  }
  if (message.kind === "requestSessionSnapshot") {
    return hasExactKeys(message, ["kind"]) ? { kind: "requestSessionSnapshot" } : undefined;
  }
  if (message.kind === "rendererSynchronized") {
    const hasSessionIdentity =
      isNonEmptyString(message.sessionId) && Number.isSafeInteger(message.revision) && Number(message.revision) >= 0;
    const hasNoSessionIdentity = message.sessionId === null && message.revision === null;
    return hasExactKeys(message, ["kind", "syncId", "sessionId", "revision"]) &&
      isRendererControlId(message.syncId) &&
      (hasSessionIdentity || hasNoSessionIdentity)
      ? {
          kind: "rendererSynchronized",
          syncId: message.syncId,
          sessionId: hasSessionIdentity ? String(message.sessionId) : null,
          revision: hasSessionIdentity ? Number(message.revision) : null
        }
      : undefined;
  }
  if (message.kind === "rendererRetiring") {
    const hasSessionIdentity =
      isNonEmptyString(message.sessionId) && Number.isSafeInteger(message.revision) && Number(message.revision) >= 0;
    const hasNoSessionIdentity = message.sessionId === null && message.revision === null;
    return hasExactKeys(message, ["kind", "syncId", "sessionId", "revision"]) &&
      isRendererControlId(message.syncId) &&
      (hasSessionIdentity || hasNoSessionIdentity)
      ? {
          kind: "rendererRetiring",
          syncId: message.syncId,
          sessionId: hasSessionIdentity ? String(message.sessionId) : null,
          revision: hasSessionIdentity ? Number(message.revision) : null
        }
      : undefined;
  }
  if (message.kind === "setViewContext") {
    return hasExactKeys(message, ["kind", "viewContextId"]) && isBoundedViewId(message.viewContextId)
      ? { kind: "setViewContext", viewContextId: message.viewContextId }
      : undefined;
  }
  if (message.kind === "cancelViewRequests") {
    if (!hasExactKeys(message, ["kind", "viewRequestIds"])) return undefined;
    const viewRequestIds = decodeCancelledViewRequestIds(message.viewRequestIds);
    return viewRequestIds ? { kind: "cancelViewRequests", viewRequestIds } : undefined;
  }
  if (message.kind === "prioritizeViewRequest") {
    return hasExactKeys(message, ["kind", "viewRequestId"]) && isBoundedViewId(message.viewRequestId)
      ? { kind: "prioritizeViewRequest", viewRequestId: message.viewRequestId }
      : undefined;
  }
  if (message.kind === "updateViewState") {
    if (!hasExactKeys(message, ["kind", "state"])) return undefined;
    const state = decodeGridViewState(message.state);
    return state ? { kind: "updateViewState", state } : undefined;
  }
  if (message.kind === "clearStepInspection") {
    return hasExactKeys(message, ["kind"]) ? { kind: "clearStepInspection" } : undefined;
  }
  if (message.kind === "rewriteCleaningPlan") {
    return hasExactKeys(message, ["kind", "action", "stepId", "offset", "limit", "columnOffset", "columnLimit"]) &&
      (message.action === "applyDraft" || message.action === "deleteStep") &&
      isNonEmptyString(message.stepId) &&
      isNonNegativeInteger(message.offset) &&
      isPositiveBoundedInteger(message.limit, 10_000) &&
      isNonNegativeInteger(message.columnOffset) &&
      isPositiveBoundedInteger(message.columnLimit, 256)
      ? {
          kind: "rewriteCleaningPlan",
          action: message.action,
          stepId: message.stepId,
          offset: message.offset,
          limit: message.limit,
          columnOffset: message.columnOffset,
          columnLimit: message.columnLimit
        }
      : undefined;
  }
  if (message.kind === "changeImportOptions") {
    return hasExactKeys(message, ["kind"], ["actionId"]) &&
      (message.actionId === undefined || isRendererControlId(message.actionId))
      ? {
          kind: "changeImportOptions",
          ...(message.actionId === undefined ? {} : { actionId: message.actionId })
        }
      : undefined;
  }
  if (message.kind === "changeBackend") {
    return hasExactKeys(message, ["kind"]) ? { kind: "changeBackend" } : undefined;
  }
  if (message.kind === "installRuntimeDependencies") {
    return hasExactKeys(message, ["kind"]) ? { kind: "installRuntimeDependencies" } : undefined;
  }
  if (message.kind === "exportData") {
    return hasExactKeys(message, ["kind"]) ? { kind: "exportData" } : undefined;
  }
  if (message.kind === "switchSessionMode") {
    if (!hasExactKeys(message, ["kind", "mode", "state"]) || !isSessionMode(message.mode)) return undefined;
    const state = decodeGridViewState(message.state);
    return state ? { kind: "switchSessionMode", mode: message.mode, state } : undefined;
  }
  if (message.kind === "reconnectLiveSource") {
    return hasExactKeys(message, ["kind"]) ? { kind: "reconnectLiveSource" } : undefined;
  }
  if (
    message.kind !== "runtimeRequest" ||
    !hasExactKeys(message, ["kind", "request"], ["viewContextId", "priority", "purpose"]) ||
    !isRecord(message.request) ||
    Object.prototype.hasOwnProperty.call(message.request, "sessionId") ||
    Object.prototype.hasOwnProperty.call(message.request, "revision") ||
    (Object.prototype.hasOwnProperty.call(message.request, "viewRequestId") &&
      !isBoundedViewId(message.request.viewRequestId)) ||
    (message.viewContextId !== undefined && !isBoundedViewId(message.viewContextId)) ||
    (message.priority !== undefined && message.priority !== "interactive" && message.priority !== "background") ||
    (message.purpose !== undefined && message.purpose !== "clipboardColumn")
  ) {
    return undefined;
  }
  const request = {
    ...message.request,
    sessionId: context.sessionId ?? "pending-session",
    revision: context.sessionRevision
  };
  if (!isOpenWranglerRequest(request) || !WEBVIEW_RUNTIME_REQUEST_KINDS.has(request.kind)) return undefined;
  if (message.priority !== undefined && request.kind !== "getSummary" && request.kind !== "getDatasetStats") {
    return undefined;
  }
  if (
    message.purpose !== undefined &&
    (request.kind !== "getPage" || message.viewContextId === undefined || message.priority !== undefined)
  ) {
    return undefined;
  }
  if (
    request.kind === "previewStep" &&
    (!context.snapshot || !supportsOperation(context.snapshot.metadata.capabilities, request.step.kind))
  ) {
    return undefined;
  }
  return {
    kind: "runtimeRequest",
    request,
    ...(message.viewContextId === undefined ? {} : { viewContextId: message.viewContextId }),
    ...(message.priority === undefined ? {} : { priority: message.priority }),
    ...(message.purpose === undefined ? {} : { purpose: message.purpose })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRendererControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{32}$/u.test(value);
}

function isBoundedViewId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_WEBVIEW_VIEW_ID_CODE_UNITS;
}

function decodeCancelledViewRequestIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CANCEL_VIEW_REQUEST_IDS) return undefined;
  let totalCodeUnits = 0;
  const uniqueIds = new Set<string>();
  for (const viewRequestId of value) {
    if (!isBoundedViewId(viewRequestId) || uniqueIds.has(viewRequestId)) return undefined;
    totalCodeUnits += viewRequestId.length;
    if (totalCodeUnits > MAX_CANCEL_VIEW_REQUEST_ID_CODE_UNITS) return undefined;
    uniqueIds.add(viewRequestId);
  }
  return [...value];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveBoundedInteger(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "viewing" || value === "editing";
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
