import { describe, expect, it, vi } from "vitest";

import {
  createFocusedReleasedRAcceptanceHandlers,
  type FocusedReleasedRAcceptanceOwners
} from "./extensionHost/focusedReleasedRAcceptance";

function owners(
  calls: string[],
  platform: NodeJS.Platform = "linux"
): FocusedReleasedRAcceptanceOwners<"testing", "workbench"> {
  return {
    testing: "testing",
    testPython: "/opt/openwrangler/python",
    platform,
    screenshotOutput: "/tmp/openwrangler-screenshots",
    assertNativeEditorTooling: async () => {
      calls.push("tooling");
      return true;
    },
    connectToEditorWorkbench: async () => {
      calls.push("workbench");
      return "workbench";
    },
    createLiterateDirectory: () => {
      calls.push("create-directory");
      return "/tmp/openwrangler-r-literate";
    },
    cleanupLiterateDirectory: (directory) => {
      calls.push(`cleanup:${directory}`);
    },
    exerciseInteractiveTerminalJourney: async (testing, workbench) => {
      calls.push(`interactive:${testing}:${workbench}`);
    },
    exerciseLiterateDocumentJourneys: async (testing, workbench, directory, screenshotOutput) => {
      calls.push(`literate:${testing}:${workbench}:${directory}:${screenshotOutput ?? "none"}`);
    },
    log: (message) => {
      calls.push(`log:${message}`);
    },
    recordProgress: (checkpoint) => {
      calls.push(`progress:${checkpoint}`);
    }
  };
}

describe("focused released-R acceptance", () => {
  it("pins editor tooling before the interactive journey", async () => {
    const calls: string[] = [];

    await createFocusedReleasedRAcceptanceHandlers(owners(calls)).focusedRInteractive();

    expect(calls).toEqual([
      "progress:jupyter-r:interactive:tooling-start",
      "tooling",
      "progress:jupyter-r:interactive:tooling-ready",
      "workbench",
      "interactive:testing:workbench",
      "log:Open Wrangler active R terminal acceptance passed."
    ]);
  });

  it("requires the runner-selected Python before probing interactive tooling", async () => {
    const calls: string[] = [];
    const configured = { ...owners(calls), testPython: undefined };

    await expect(createFocusedReleasedRAcceptanceHandlers(configured).focusedRInteractive()).rejects.toThrow(
      "Focused active R acceptance requires the runner-selected host Python environment."
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ["linux", "/tmp/openwrangler-screenshots"],
    ["darwin", "none"],
    ["win32", "none"]
  ] as const)("passes the bounded screenshot output only on %s", async (platform, expectedOutput) => {
    const calls: string[] = [];

    await createFocusedReleasedRAcceptanceHandlers(owners(calls, platform)).focusedRLiterateDocuments();

    expect(calls).toEqual([
      "tooling",
      "create-directory",
      "workbench",
      `literate:testing:workbench:/tmp/openwrangler-r-literate:${expectedOutput}`,
      "cleanup:/tmp/openwrangler-r-literate",
      "log:Open Wrangler R Markdown and Quarto acceptance passed."
    ]);
  });

  it("cleans the literate fixture after a journey failure", async () => {
    const calls: string[] = [];
    const configured = {
      ...owners(calls),
      exerciseLiterateDocumentJourneys: vi.fn(async () => {
        calls.push("literate-failed");
        throw new Error("journey failed");
      })
    };

    await expect(createFocusedReleasedRAcceptanceHandlers(configured).focusedRLiterateDocuments()).rejects.toThrow(
      "journey failed"
    );
    expect(calls).toEqual([
      "tooling",
      "create-directory",
      "workbench",
      "literate-failed",
      "cleanup:/tmp/openwrangler-r-literate"
    ]);
  });
});
