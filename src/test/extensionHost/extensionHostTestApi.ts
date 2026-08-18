import type * as vscode from "vscode";
import type { NotebookCellResultTrackerDiagnostics } from "../../extension/notebooks/notebookCellResult";
import type { PythonInteractiveDiagnostics } from "../../extension/notebooks/pythonInteractiveCommands";
import type { SessionSchedulerState } from "../../extension/sessionCoordinator";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionMetadata,
  StepInspectionResponse
} from "../../shared/protocol";
import type { GridViewState, PersistedViewingState } from "../../shared/viewState";

export interface TestApi {
  request(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
  setActiveSession(sessionId: string | undefined): void;
  activeSession():
    | {
        sessionId: string;
        metadata: SessionMetadata;
        code?: string;
        viewState: PersistedViewingState;
        stepInspectionActive?: boolean;
        stepInspection?: StepInspectionResponse;
      }
    | undefined;
  sessionSnapshot(sessionId: string): ReturnType<TestApi["activeSession"]>;
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
  synchronizePanel(sessionId: string): Promise<boolean>;
  ensurePanelSynchronized(sessionId: string, deadlineMs: number): Promise<boolean>;
  previewPanelStep(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<Extract<OpenWranglerResponse, { kind: "sessionOpened" }> | undefined>;
  rewriteCleaningPlan(
    sessionId: string,
    revision: number,
    stepId: string,
    action: "applyDraft" | "deleteStep"
  ): Promise<OpenWranglerResponse | undefined>;
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
  panelSynchronizationReceipt(
    sessionId: string
  ): Readonly<{ syncId: string; sessionId: string; revision: number; layoutTransitionPending: boolean }> | undefined;
  retirePanelRenderer(sessionId: string): boolean;
  sessionSchedulerState(sessionId: string): SessionSchedulerState | undefined;
  panelOpenResponse(): OpenWranglerResponse | undefined;
  diagnostics(): {
    activeSessionId?: string;
    sessionCount: number;
    sessions: Array<{
      publicId: string;
      runtimeId: string;
      publicRevision: number;
      runtimeRevision: number;
      sourceLabel: string;
    }>;
  };
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  runtimeEnvironment(): Readonly<{ executable: string; source: string; version: string }> | undefined;
  declineRuntimeDependencyInstallation(): Promise<boolean>;
  shutdownRuntimeBridgeForTesting(): Promise<void>;
  disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined>;
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
  notebookInsertionStatus():
    | "applied"
    | "stale"
    | "indeterminate"
    | "rejected"
    | "untrusted"
    | "missing-code"
    | "unsupported-source"
    | "missing-notebook"
    | "missing-source-document"
    | "dispatching"
    | undefined;
  viewSortDispatchStatus():
    | "sent"
    | "invalid-target"
    | "stale-target"
    | "inspection-active"
    | "priority-boundary"
    | "panel-unavailable"
    | undefined;
  notebookCellResultDiagnostics(): NotebookCellResultTrackerDiagnostics | undefined;
  pythonInteractiveDiagnostics(): PythonInteractiveDiagnostics | undefined;
}

export interface ExtensionApi {
  testing?: TestApi;
}
