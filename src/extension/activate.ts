import * as vscode from "vscode";
import { registerFileCommands } from "./files/fileOpen";
import { registerTrustedPickleConversion } from "./files/trustedPickleConversion";
import { TrustedPickleWorkerLifecycle } from "./files/trustedPickleWorker";
import { registerNotebookCommands } from "./notebooks/jupyterBridge";
import {
  NotebookCellResultTracker,
  registerNotebookCellResultAction,
  type NotebookCellResultTrackerDiagnostics
} from "./notebooks/notebookCellResult";
import { registerNotebookRendererMessaging } from "./notebooks/rendererMessaging";
import { NotebookPreviewCoordinator } from "./notebooks/notebookPreviewCoordinator";
import {
  registerPythonInteractiveCommands,
  type PythonInteractiveDiagnostics
} from "./notebooks/pythonInteractiveCommands";
import { PythonBridge } from "./pythonBridge";
import { registerRDocumentCommands } from "./r/rDocumentCommands";
import { registerRInteractiveCommands, type RLiveVariableProvider } from "./r/rInteractiveCommands";
import { SessionCoordinator } from "./sessionCoordinator";
import { registerRuntimeCommands } from "./runtimeCommands";
import {
  registerNativeViews,
  type NotebookInsertionDiagnosticStatus,
  type ViewSortDispatchStatus
} from "./nativeViews";
import { OpenWranglerPanel } from "./webviewPanel";
import type { GridViewState } from "../shared/viewState";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionOpenedResponse } from "../shared/protocol";

export interface OpenWranglerTestApi {
  request: ReturnType<SessionCoordinator["createBridge"]>["request"];
  setActiveSession(sessionId: string | undefined): void;
  activeSession: SessionCoordinator["activeSession"];
  sessionSnapshot: SessionCoordinator["sessionSnapshot"];
  updateViewState(sessionId: string, state: GridViewState): Promise<void>;
  synchronizePanel(sessionId: string): Promise<boolean>;
  ensurePanelSynchronized(sessionId: string, deadlineMs: number): Promise<boolean>;
  previewPanelStep(
    request: Extract<OpenWranglerRequest, { kind: "previewStep" }>
  ): Promise<SessionOpenedResponse | undefined>;
  panelHydrated(sessionId: string): boolean;
  panelSynchronizable(sessionId: string): boolean;
  panelSynchronizationReceipt(
    sessionId: string
  ): Readonly<{ syncId: string; sessionId: string; revision: number; layoutTransitionPending: boolean }> | undefined;
  cancelViewRequests(sessionId: string, viewRequestIds: readonly string[]): void;
  requestExecutionCheckpoint: SessionCoordinator["testingRequestExecutionCheckpoint"];
  sessionSchedulerState: SessionCoordinator["testingSessionSchedulerState"];
  panelOpenResponse(): OpenWranglerResponse | undefined;
  diagnostics: SessionCoordinator["diagnostics"];
  restartRuntime(reason?: string): void;
  runtimeGeneration(): number;
  runtimeRunning(): boolean;
  runtimeEnvironment(): Readonly<{ executable: string; source: string; version: string }> | undefined;
  declineRuntimeDependencyInstallation(): Promise<boolean>;
  declineRuntimeDependencyRevalidation(): Promise<boolean>;
  shutdownRuntimeBridgeForTesting(): Promise<void>;
  disposePanelForSession(sessionId: string): Promise<OpenWranglerResponse | undefined>;
  setCodeForExport(code: string): void;
  exportCodeTo(destination: vscode.Uri): Promise<void>;
  notebookInsertionStatus(): NotebookInsertionDiagnosticStatus | undefined;
  viewSortDispatchStatus(): ViewSortDispatchStatus | undefined;
  notebookCellResultDiagnostics(): NotebookCellResultTrackerDiagnostics | undefined;
  pythonInteractiveDiagnostics(): PythonInteractiveDiagnostics | undefined;
}

export interface OpenWranglerExtensionApi {
  testing?: OpenWranglerTestApi;
}

let activeCoordinator: SessionCoordinator | undefined;
let activeBridge: PythonBridge | undefined;
let activePickleWorkers: TrustedPickleWorkerLifecycle | undefined;
let activeRInteractive: RLiveVariableProvider | undefined;

const NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT = "openWrangler.forceNotebookEditorTitleAction";

export function isCursorAppName(appName: string): boolean {
  const normalized = appName.trim().toLowerCase();
  return normalized === "cursor" || normalized.startsWith("cursor ");
}

export async function activate(context: vscode.ExtensionContext): Promise<OpenWranglerExtensionApi | undefined> {
  const notebookCellResults = new NotebookCellResultTracker();
  notebookCellResults.start();
  try {
    await setNotebookEditorTitleActionContext(isCursorAppName(vscode.env.appName));
  } catch (error) {
    notebookCellResults.dispose();
    throw error;
  }

  const bridge = new PythonBridge(context);
  const coordinator = new SessionCoordinator(context.workspaceState, (message) => bridge.reportDiagnostic(message));
  const pickleWorkers = new TrustedPickleWorkerLifecycle();
  activeCoordinator = coordinator;
  activeBridge = bridge;
  activePickleWorkers = pickleWorkers;
  const coordinatedBridge = coordinator.createBridge(bridge);
  context.subscriptions.push(pickleWorkers, coordinator, bridge);

  registerFileCommands(context, coordinatedBridge);
  registerTrustedPickleConversion(context, bridge, { runWorker: (options) => pickleWorkers.run(options) });
  const notebookVariables = registerPythonInteractiveCommands(context, coordinator);
  const rInteractive = registerRInteractiveCommands(context, coordinator);
  activeRInteractive = rInteractive;
  const nativeViews = registerNativeViews(context, coordinator, notebookVariables, rInteractive);
  registerRuntimeCommands(context, bridge);
  registerRDocumentCommands(context, coordinator, { python: notebookVariables, r: rInteractive });
  registerNotebookCommands(context, coordinator);
  registerNotebookCellResultAction(context, coordinator, notebookCellResults);
  registerNotebookRendererMessaging(context, coordinator);
  context.subscriptions.push(new NotebookPreviewCoordinator(context));
  rInteractive.startAutomaticDiscovery();

  if (process.env.OPEN_WRANGLER_EXTENSION_TESTS === "1") {
    return {
      testing: {
        request: (request, options) => coordinatedBridge.request(request, options),
        setActiveSession: (sessionId) => coordinator.setActive(sessionId),
        activeSession: () => coordinator.activeSession(),
        sessionSnapshot: (sessionId) => coordinator.sessionSnapshot(sessionId),
        updateViewState: async (sessionId, state) => coordinatedBridge.updateViewState?.(sessionId, state),
        synchronizePanel: (sessionId) => OpenWranglerPanel.synchronizePanelForSession(sessionId),
        ensurePanelSynchronized: (sessionId, deadlineMs) =>
          OpenWranglerPanel.ensurePanelSynchronizedForSession(sessionId, deadlineMs),
        previewPanelStep: (request) => OpenWranglerPanel.previewStepForSessionForTesting(request),
        panelHydrated: (sessionId) => OpenWranglerPanel.panelHydratedForSession(sessionId),
        panelSynchronizable: (sessionId) => OpenWranglerPanel.panelSynchronizableForSession(sessionId),
        panelSynchronizationReceipt: (sessionId) => OpenWranglerPanel.panelSynchronizationReceiptForSession(sessionId),
        cancelViewRequests: (sessionId, viewRequestIds) =>
          coordinatedBridge.cancelViewRequests?.(sessionId, viewRequestIds),
        requestExecutionCheckpoint: (sessionId, requestKind, viewRequestId) =>
          coordinator.testingRequestExecutionCheckpoint(sessionId, requestKind, viewRequestId),
        sessionSchedulerState: (sessionId) => coordinator.testingSessionSchedulerState(sessionId),
        panelOpenResponse: () => OpenWranglerPanel.openResponseForTesting(),
        diagnostics: () => coordinator.diagnostics(),
        restartRuntime: (reason) => bridge.restart(reason),
        runtimeGeneration: () => bridge.runtimeGeneration,
        runtimeRunning: () => bridge.runtimeRunning,
        runtimeEnvironment: () => bridge.runtimeEnvironmentForTesting(),
        declineRuntimeDependencyInstallation: () => bridge.declineMissingDependencyInstallForTesting(),
        declineRuntimeDependencyRevalidation: () => bridge.declineRuntimeDependencyRevalidationForTesting(),
        shutdownRuntimeBridgeForTesting: () => bridge.shutdown(),
        disposePanelForSession: (sessionId) => OpenWranglerPanel.disposePanelForSession(sessionId),
        setCodeForExport: (code) => nativeViews.setCodeForExport(code),
        exportCodeTo: (destination) => nativeViews.exportCodeTo(destination),
        notebookInsertionStatus: () => nativeViews.notebookInsertionStatus(),
        viewSortDispatchStatus: () => nativeViews.viewSortDispatchStatus(),
        notebookCellResultDiagnostics: () => notebookCellResults.diagnosticsForTesting(),
        pythonInteractiveDiagnostics: () => notebookVariables.diagnosticsForTesting()
      }
    };
  }
  return undefined;
}

async function setNotebookEditorTitleActionContext(value: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", NOTEBOOK_EDITOR_TITLE_ACTION_CONTEXT, value);
}

export async function deactivate(): Promise<void> {
  const coordinator = activeCoordinator;
  const bridge = activeBridge;
  const pickleWorkers = activePickleWorkers;
  const rInteractive = activeRInteractive;
  activeCoordinator = undefined;
  activeBridge = undefined;
  activePickleWorkers = undefined;
  activeRInteractive = undefined;

  const failures: unknown[] = [];
  try {
    await pickleWorkers?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  try {
    await rInteractive?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  try {
    await coordinator?.shutdown();
  } catch (error) {
    failures.push(error);
  }
  try {
    await bridge?.shutdown();
  } catch (error) {
    failures.push(error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Open Wrangler extension deactivation encountered multiple shutdown failures.");
  }
}
