import type {
  PythonInteractiveActiveDiagnosticStage,
  PythonInteractiveDiagnostics
} from "../../extension/notebooks/pythonInteractiveCommands";

export interface ReleasedPythonTerminalFailureObserverOptions {
  readonly initialInvocation: number;
  readonly checkpoint: string;
  readonly recordProgress: (checkpoint: string) => void;
  readonly terminalError: (diagnostics: PythonInteractiveDiagnostics) => Error | PromiseLike<Error>;
}

export type ReleasedPythonTerminalFailureObserver = (
  diagnostics: PythonInteractiveDiagnostics | undefined
) => Promise<void>;

export function createReleasedPythonTerminalFailureObserver({
  initialInvocation,
  checkpoint,
  recordProgress,
  terminalError
}: ReleasedPythonTerminalFailureObserverOptions): ReleasedPythonTerminalFailureObserver {
  let observedInvocation = initialInvocation;
  let lastActiveStage: PythonInteractiveActiveDiagnosticStage | undefined;

  return async (diagnostics): Promise<void> => {
    if (!diagnostics || diagnostics.invocation <= initialInvocation) return;
    if (diagnostics.invocation !== observedInvocation) {
      observedInvocation = diagnostics.invocation;
      lastActiveStage = undefined;
    }
    if (diagnostics.lastActiveStage && diagnostics.lastActiveStage !== lastActiveStage) {
      lastActiveStage = diagnostics.lastActiveStage;
      recordProgress(`${checkpoint}:python-${diagnostics.lastActiveStage}`);
    }
    if (diagnostics.stage !== "failed") return;

    recordProgress(`${checkpoint}:python-${diagnostics.lastActiveStage ?? "unknown-stage"}:failed`);
    throw await terminalError(diagnostics);
  };
}
