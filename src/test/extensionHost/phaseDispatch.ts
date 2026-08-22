import {
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  EXTENSION_HOST_TEST_SELECTORS,
  PYSPARK_PRERELEASE_DENIAL_SELECTOR,
  releasedJupyterScenario
} from "./releasedJupyterScenarios";
import type { ExtensionHostTestSelector, ReleasedJupyterDispatchPhase } from "./releasedJupyterScenarios";

export { CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, EXTENSION_HOST_TEST_SELECTORS, PYSPARK_PRERELEASE_DENIAL_SELECTOR };
export type { ExtensionHostTestSelector, ReleasedJupyterDispatchPhase };

export type DataWranglerCoexistencePhase =
  | "jupyter-coexist-open-select"
  | "jupyter-coexist-open-restart"
  | "jupyter-coexist-data-select"
  | "jupyter-coexist-data-restart";

export interface ExtensionHostPhaseEnvironment {
  readonly OPEN_WRANGLER_TEST_EDITOR?: string;
  readonly OPEN_WRANGLER_TEST_PHASE?: string;
  readonly OPEN_WRANGLER_TEST_PYTHON?: string;
  readonly OPEN_WRANGLER_TEST_SELECTOR?: string;
}

export interface ExtensionHostPhaseSelection {
  readonly editor: string | undefined;
  readonly phase: string;
  readonly platform: NodeJS.Platform;
  readonly selector: ExtensionHostTestSelector | undefined;
  readonly testPython: string | undefined;
}

export interface ExtensionHostPhaseHandlers {
  readonly dataWranglerCoexistence: (phase: DataWranglerCoexistencePhase) => Promise<void>;
  readonly focusedRInteractive: () => Promise<void>;
  readonly focusedRLiterateDocuments: () => Promise<void>;
  readonly platformSmoke: () => Promise<void>;
  readonly pythonEnvironment: () => Promise<void>;
  readonly releasedJupyter: (
    phase: ReleasedJupyterDispatchPhase,
    selector: ExtensionHostTestSelector | undefined
  ) => Promise<void>;
  readonly remoteWorkspace: () => Promise<void>;
  readonly seed: () => Promise<void>;
}

export const EXTENSION_HOST_TEST_SELECTOR_ERROR =
  'OPEN_WRANGLER_TEST_SELECTOR must be unset, "candidate-compatibility-seam", "pyspark-prerelease-denial", "core-operations", "categorical-operations", "value-operations", "pivot-wider", "kernel-restart", "native-frames", "interactive-terminal", or "literate-documents".';

export const EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR =
  "candidate-compatibility-seam requires jupyter-allow in Cursor; pyspark-prerelease-denial requires jupyter-pyspark in VS Code; every R selector requires jupyter-r.";

const extensionHostTestSelectors = new Set<string>(EXTENSION_HOST_TEST_SELECTORS);

export function parseExtensionHostPhaseSelection(
  environment: ExtensionHostPhaseEnvironment,
  platform: NodeJS.Platform
): ExtensionHostPhaseSelection {
  const phase = environment.OPEN_WRANGLER_TEST_PHASE ?? "verify";
  const rawSelector = environment.OPEN_WRANGLER_TEST_SELECTOR;
  if (rawSelector !== undefined && !extensionHostTestSelectors.has(rawSelector)) {
    throw new Error(EXTENSION_HOST_TEST_SELECTOR_ERROR);
  }
  const selector = rawSelector as ExtensionHostTestSelector | undefined;
  if (
    selector !== undefined &&
    !releasedJupyterScenario({
      editor: environment.OPEN_WRANGLER_TEST_EDITOR,
      phaseId: phase,
      platform,
      selector
    })
  ) {
    throw new Error(EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR);
  }
  return Object.freeze({
    editor: environment.OPEN_WRANGLER_TEST_EDITOR,
    phase,
    platform,
    selector,
    testPython: environment.OPEN_WRANGLER_TEST_PYTHON
  });
}

export function isDataWranglerCoexistencePhase(phase: string): phase is DataWranglerCoexistencePhase {
  return (
    phase === "jupyter-coexist-open-select" ||
    phase === "jupyter-coexist-open-restart" ||
    phase === "jupyter-coexist-data-select" ||
    phase === "jupyter-coexist-data-restart"
  );
}

export async function dispatchExtensionHostPhase(
  selection: ExtensionHostPhaseSelection,
  handlers: ExtensionHostPhaseHandlers
): Promise<boolean> {
  if (isDataWranglerCoexistencePhase(selection.phase)) {
    await handlers.dataWranglerCoexistence(selection.phase);
    return true;
  }
  const releasedJupyter = releasedJupyterScenario({
    editor: selection.editor,
    phaseId: selection.phase,
    platform: selection.platform,
    selector: selection.selector
  });
  if (releasedJupyter?.runnerKey === "focused-r-interactive") {
    await handlers.focusedRInteractive();
    return true;
  }
  if (releasedJupyter?.runnerKey === "focused-r-literate") {
    await handlers.focusedRLiterateDocuments();
    return true;
  }
  if (releasedJupyter?.runnerKey === "released-jupyter") {
    await handlers.releasedJupyter(releasedJupyter.phaseId, releasedJupyter.selector);
    return true;
  }
  if (selection.phase === "python-environment") {
    await handlers.pythonEnvironment();
    return true;
  }
  if (selection.phase === "platform-smoke") {
    await handlers.platformSmoke();
    return true;
  }
  if (selection.phase === "remote-workspace") {
    await handlers.remoteWorkspace();
    return true;
  }
  if (selection.phase === "seed") {
    await handlers.seed();
    return true;
  }
  return false;
}
