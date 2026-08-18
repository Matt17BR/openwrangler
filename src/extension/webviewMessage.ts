import { supportsOperation } from "../shared/operations";
import type { OpenWranglerRequest, SessionMode, SessionOpenedResponse } from "../shared/protocol";
import { isOpenWranglerRequest } from "../shared/protocolValidation";
import { decodeGridViewState, type GridViewState } from "../shared/viewState";

export interface WebviewMessageDecodeContext {
  sessionId: string | undefined;
  sessionRevision: number;
  snapshot: Pick<SessionOpenedResponse, "metadata"> | undefined;
}

export type WebviewRequest =
  | { kind: "ready" }
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

export function decodeWebviewMessage(
  message: unknown,
  context: WebviewMessageDecodeContext
): WebviewRequest | undefined {
  if (!isRecord(message) || typeof message.kind !== "string") return undefined;
  if (message.kind === "ready") {
    return hasExactKeys(message, ["kind"]) ? { kind: "ready" } : undefined;
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
    return hasExactKeys(message, ["kind", "viewContextId"]) && isNonEmptyString(message.viewContextId)
      ? { kind: "setViewContext", viewContextId: message.viewContextId }
      : undefined;
  }
  if (message.kind === "cancelViewRequests") {
    return hasExactKeys(message, ["kind", "viewRequestIds"]) &&
      Array.isArray(message.viewRequestIds) &&
      message.viewRequestIds.every(isNonEmptyString)
      ? { kind: "cancelViewRequests", viewRequestIds: [...message.viewRequestIds] }
      : undefined;
  }
  if (message.kind === "prioritizeViewRequest") {
    return hasExactKeys(message, ["kind", "viewRequestId"]) && isNonEmptyString(message.viewRequestId)
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
    !hasExactKeys(message, ["kind", "request"], ["viewContextId", "priority"]) ||
    !isRecord(message.request) ||
    Object.prototype.hasOwnProperty.call(message.request, "sessionId") ||
    Object.prototype.hasOwnProperty.call(message.request, "revision") ||
    (message.viewContextId !== undefined && !isNonEmptyString(message.viewContextId)) ||
    (message.priority !== undefined && message.priority !== "interactive" && message.priority !== "background")
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
    request.kind === "previewStep" &&
    (!context.snapshot || !supportsOperation(context.snapshot.metadata.capabilities, request.step.kind))
  ) {
    return undefined;
  }
  return {
    kind: "runtimeRequest",
    request,
    ...(message.viewContextId === undefined ? {} : { viewContextId: message.viewContextId }),
    ...(message.priority === undefined ? {} : { priority: message.priority })
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRendererControlId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{32}$/u.test(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
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
