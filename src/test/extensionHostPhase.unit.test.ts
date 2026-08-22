import { describe, expect, it } from "vitest";
import {
  CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR,
  dispatchExtensionHostPhase,
  EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR,
  EXTENSION_HOST_TEST_SELECTOR_ERROR,
  parseExtensionHostPhaseSelection,
  PYSPARK_PRERELEASE_DENIAL_SELECTOR,
  type ExtensionHostPhaseHandlers
} from "./extensionHost/phaseDispatch";

function selection(
  phase: string,
  selector?: string,
  editor?: string
): ReturnType<typeof parseExtensionHostPhaseSelection> {
  return parseExtensionHostPhaseSelection(
    {
      OPEN_WRANGLER_TEST_EDITOR: editor,
      OPEN_WRANGLER_TEST_PHASE: phase,
      OPEN_WRANGLER_TEST_SELECTOR: selector
    },
    "linux"
  );
}

function recordingHandlers(calls: string[]): ExtensionHostPhaseHandlers {
  return {
    dataWranglerCoexistence: async (phase) => {
      calls.push(`coexistence:${phase}`);
    },
    focusedRInteractive: async () => {
      calls.push("r-interactive");
    },
    focusedRLiterateDocuments: async () => {
      calls.push("r-literate");
    },
    platformSmoke: async () => {
      calls.push("platform-smoke");
    },
    pythonEnvironment: async () => {
      calls.push("python-environment");
    },
    releasedJupyter: async (phase, selector) => {
      calls.push(`jupyter:${phase}:${selector ?? "default"}`);
    },
    remoteWorkspace: async () => {
      calls.push("remote-workspace");
    },
    seed: async () => {
      calls.push("seed");
    }
  };
}

describe("extension-host phase selection", () => {
  it("defaults to verify and retains the exact runner environment", () => {
    expect(
      parseExtensionHostPhaseSelection(
        {
          OPEN_WRANGLER_TEST_EDITOR: "vscode",
          OPEN_WRANGLER_TEST_PYTHON: "/opt/openwrangler/python"
        },
        "darwin"
      )
    ).toEqual({
      editor: "vscode",
      phase: "verify",
      platform: "darwin",
      selector: undefined,
      testPython: "/opt/openwrangler/python"
    });
  });

  it("accepts the candidate seam only for released Jupyter in Cursor", () => {
    expect(selection("jupyter-allow", CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, "cursor").selector).toBe(
      CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR
    );
    for (const [phase, editor] of [
      ["jupyter-allow", "vscode"],
      ["jupyter-deny", "cursor"]
    ] as const) {
      expect(() => selection(phase, CANDIDATE_PYTHON_JUPYTER_ALLOW_SELECTOR, editor)).toThrow(
        EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR
      );
    }
  });

  it("accepts the PySpark prerelease denial only for its explicit VS Code selector", () => {
    expect(selection("jupyter-pyspark", PYSPARK_PRERELEASE_DENIAL_SELECTOR, "vscode").selector).toBe(
      PYSPARK_PRERELEASE_DENIAL_SELECTOR
    );
    for (const [phase, editor] of [
      ["jupyter-pyspark", "cursor"],
      ["jupyter-allow", "vscode"]
    ] as const) {
      expect(() => selection(phase, PYSPARK_PRERELEASE_DENIAL_SELECTOR, editor)).toThrow(
        EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR
      );
    }
  });

  it("accepts every R selector only in the local released-R phase", () => {
    for (const selector of [
      "core-operations",
      "categorical-operations",
      "value-operations",
      "pivot-wider",
      "kernel-restart",
      "native-frames",
      "interactive-terminal",
      "literate-documents"
    ] as const) {
      expect(selection("jupyter-r", selector).selector).toBe(selector);
      expect(() => selection("jupyter-r-remote", selector)).toThrow(EXTENSION_HOST_TEST_SELECTOR_ELIGIBILITY_ERROR);
    }
  });

  it("rejects selectors outside the bounded runner vocabulary", () => {
    expect(() => selection("jupyter-r", "all-the-things")).toThrow(EXTENSION_HOST_TEST_SELECTOR_ERROR);
  });
});

describe("extension-host phase dispatch", () => {
  it.each([
    ["jupyter-r", "interactive-terminal", undefined, "r-interactive"],
    ["jupyter-r", "literate-documents", undefined, "r-literate"],
    ["jupyter-coexist-open-select", undefined, undefined, "coexistence:jupyter-coexist-open-select"],
    ["jupyter-coexist-open-restart", undefined, undefined, "coexistence:jupyter-coexist-open-restart"],
    ["jupyter-coexist-data-select", undefined, undefined, "coexistence:jupyter-coexist-data-select"],
    ["jupyter-coexist-data-restart", undefined, undefined, "coexistence:jupyter-coexist-data-restart"],
    ["jupyter-deny", undefined, undefined, "jupyter:jupyter-deny:default"],
    ["jupyter-allow", undefined, undefined, "jupyter:jupyter-allow:default"],
    ["jupyter-pyspark", undefined, undefined, "jupyter:jupyter-pyspark:default"],
    [
      "jupyter-pyspark",
      PYSPARK_PRERELEASE_DENIAL_SELECTOR,
      "vscode",
      `jupyter:jupyter-pyspark:${PYSPARK_PRERELEASE_DENIAL_SELECTOR}`
    ],
    ["jupyter-remote", undefined, undefined, "jupyter:jupyter-remote:default"],
    ["jupyter-r", "core-operations", undefined, "jupyter:jupyter-r:core-operations"],
    ["jupyter-r-remote", undefined, undefined, "jupyter:jupyter-r-remote:default"],
    ["python-environment", undefined, undefined, "python-environment"],
    ["platform-smoke", undefined, undefined, "platform-smoke"],
    ["remote-workspace", undefined, undefined, "remote-workspace"],
    ["seed", undefined, undefined, "seed"]
  ] as const)("dispatches %s to its executable owner", async (phase, selector, editor, expected) => {
    const calls: string[] = [];
    await expect(
      dispatchExtensionHostPhase(selection(phase, selector, editor), recordingHandlers(calls))
    ).resolves.toBe(true);
    expect(calls).toEqual([expected]);
  });

  it.each(["verify", "single", "future-phase"])("leaves the %s flow with the entrypoint", async (phase) => {
    const calls: string[] = [];
    await expect(dispatchExtensionHostPhase(selection(phase), recordingHandlers(calls))).resolves.toBe(false);
    expect(calls).toEqual([]);
  });
});
