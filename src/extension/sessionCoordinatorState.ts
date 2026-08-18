import type {
  OpenSessionRequest,
  SessionBoundRequest,
  SessionMetadata,
  SessionMode,
  StepInspectionResponse
} from "../shared/protocol";
import type { PersistedViewingState } from "../shared/viewState";
import { publicMetadata } from "./sessionResponseCommitter";
import type { SessionRequestExecutionLane, SessionRequestScheduler } from "./sessionRequestScheduler";

export interface ActiveSessionSnapshot {
  sessionId: string;
  metadata: SessionMetadata;
  code: string;
  viewState: PersistedViewingState;
  stepInspectionActive?: boolean;
  stepInspection?: StepInspectionResponse;
}

export interface SessionCoordinatorDiagnostics {
  activeSessionId?: string;
  sessionCount: number;
  sessions: Array<{
    publicId: string;
    runtimeId: string;
    publicRevision: number;
    runtimeRevision: number;
    sourceLabel: string;
  }>;
}

export interface SessionRequestExecutionCheckpoint {
  sessionId: string;
  state: "active" | "queued";
  lane: SessionRequestExecutionLane;
  requestKind: SessionBoundRequest["kind"];
  viewRequestId: string;
}

export interface SessionSchedulerState {
  sessionId: string;
  quiescent: boolean;
  activeForegroundOperation: boolean;
  activeBackgroundOperation: boolean;
  interactiveQueueLength: number;
  backgroundQueueLength: number;
  terminalOperation: boolean;
}

export interface ActiveSessionState {
  publicId: string;
  publicRevision: number;
  metadata: SessionMetadata;
  openRequest: Pick<OpenSessionRequest, "source">;
  code: string;
  viewState: PersistedViewingState;
  latestStepInspectionKey?: string;
  stepInspection?: StepInspectionResponse;
}

export interface SessionDiagnosticsState {
  publicId: string;
  runtimeId: string;
  publicRevision: number;
  runtimeRevision: number;
  openRequest: Pick<OpenSessionRequest, "source">;
}

export interface SessionSchedulerProjectionState {
  closing: boolean;
  scheduler: Pick<SessionRequestScheduler, "checkpoint" | "snapshot">;
}

export function activeSessionSnapshot(session: ActiveSessionState): ActiveSessionSnapshot {
  const stepInspection = session.stepInspection;
  return {
    sessionId: session.publicId,
    metadata: publicMetadata(session.metadata, session.publicId, session.publicRevision, session.openRequest.source),
    code: stepInspection?.code ?? session.code,
    viewState: session.viewState,
    ...(session.latestStepInspectionKey ? { stepInspectionActive: true } : {}),
    ...(stepInspection ? { stepInspection } : {})
  };
}

export function sessionModeName(mode: SessionMode): "Editing" | "Viewing" {
  return mode === "editing" ? "Editing" : "Viewing";
}

export function sessionCoordinatorDiagnostics(
  activeSessionId: string | undefined,
  sessions: Iterable<SessionDiagnosticsState>
): SessionCoordinatorDiagnostics {
  const activeSessions = [...sessions];
  return {
    activeSessionId,
    sessionCount: activeSessions.length,
    sessions: activeSessions.map((session) => ({
      publicId: session.publicId,
      runtimeId: session.runtimeId,
      publicRevision: session.publicRevision,
      runtimeRevision: session.runtimeRevision,
      sourceLabel: session.openRequest.source.label
    }))
  };
}

export function sessionRequestExecutionCheckpoint(
  sessionId: string,
  session: SessionSchedulerProjectionState | undefined,
  requestKind: SessionBoundRequest["kind"],
  viewRequestId: string
): SessionRequestExecutionCheckpoint | undefined {
  if (!session || session.closing || viewRequestId.length === 0) return undefined;
  const checkpoint = session.scheduler.checkpoint(requestKind, viewRequestId);
  return checkpoint ? { sessionId, ...checkpoint } : undefined;
}

export function sessionSchedulerState(
  sessionId: string,
  session: SessionSchedulerProjectionState | undefined
): SessionSchedulerState | undefined {
  return session ? { sessionId, ...session.scheduler.snapshot() } : undefined;
}
