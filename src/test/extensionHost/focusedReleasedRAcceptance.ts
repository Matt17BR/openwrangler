import assert from "node:assert/strict";

import type { ExtensionHostPhaseHandlers } from "./phaseDispatch";

export type FocusedReleasedRAcceptanceHandlers = Pick<
  ExtensionHostPhaseHandlers,
  "focusedRInteractive" | "focusedRLiterateDocuments"
>;

export interface FocusedReleasedRAcceptanceOwners<TTesting, TWorkbench> {
  readonly testing: TTesting;
  readonly testPython: string | undefined;
  readonly platform: NodeJS.Platform;
  readonly screenshotOutput: string | undefined;
  readonly assertNativeEditorTooling: () => Promise<boolean>;
  readonly connectToEditorWorkbench: () => Promise<TWorkbench>;
  readonly createLiterateDirectory: () => string;
  readonly cleanupLiterateDirectory: (directory: string) => void;
  readonly exerciseInteractiveTerminalJourney: (testing: TTesting, workbench: TWorkbench) => Promise<void>;
  readonly exerciseLiterateDocumentJourneys: (
    testing: TTesting,
    workbench: TWorkbench,
    directory: string,
    screenshotOutput: string | undefined
  ) => Promise<void>;
  readonly log: (message: string) => void;
  readonly recordProgress: (checkpoint: string) => void;
}

export function createFocusedReleasedRAcceptanceHandlers<TTesting, TWorkbench>(
  owners: FocusedReleasedRAcceptanceOwners<TTesting, TWorkbench>
): FocusedReleasedRAcceptanceHandlers {
  return {
    focusedRInteractive: async () => {
      assert.ok(owners.testPython, "Focused active R acceptance requires the runner-selected host Python environment.");
      owners.recordProgress("jupyter-r:interactive:tooling-start");
      assert.equal(
        await owners.assertNativeEditorTooling(),
        true,
        "Focused active R acceptance requires the pinned official R and Quarto editor tooling."
      );
      owners.recordProgress("jupyter-r:interactive:tooling-ready");
      await owners.exerciseInteractiveTerminalJourney(owners.testing, await owners.connectToEditorWorkbench());
      owners.log("Open Wrangler active R terminal acceptance passed.");
    },
    focusedRLiterateDocuments: async () => {
      assert.equal(
        await owners.assertNativeEditorTooling(),
        true,
        "Focused literate R acceptance requires the pinned official R and Quarto editor tooling."
      );
      const directory = owners.createLiterateDirectory();
      try {
        await owners.exerciseLiterateDocumentJourneys(
          owners.testing,
          await owners.connectToEditorWorkbench(),
          directory,
          owners.platform === "linux" ? owners.screenshotOutput : undefined
        );
      } finally {
        owners.cleanupLiterateDirectory(directory);
      }
      owners.log("Open Wrangler R Markdown and Quarto acceptance passed.");
    }
  };
}
