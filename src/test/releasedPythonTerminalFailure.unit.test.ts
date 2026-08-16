import type { PythonInteractiveDiagnostics } from "../extension/notebooks/pythonInteractiveCommands";
import { describe, expect, it, vi } from "vitest";
import { createReleasedPythonTerminalFailureObserver } from "./extensionHost/releasedPythonTerminalFailure";

function diagnostics(
  invocation: number,
  stage: PythonInteractiveDiagnostics["stage"],
  lastActiveStage?: PythonInteractiveDiagnostics["lastActiveStage"]
): PythonInteractiveDiagnostics {
  return {
    invocation,
    stage,
    lastActiveStage,
    stages: [stage]
  };
}

describe("released Python terminal failure observer", () => {
  it("ignores absent and pre-existing invocations", async () => {
    const progress = vi.fn();
    const terminalError = vi.fn(() => new Error("terminal"));
    const observe = createReleasedPythonTerminalFailureObserver({
      initialInvocation: 4,
      checkpoint: "python-entry",
      recordProgress: progress,
      terminalError
    });

    await observe(undefined);
    await observe(diagnostics(4, "failed", "opening-variable"));
    await observe(diagnostics(3, "failed", "opening-variable"));

    expect(progress).not.toHaveBeenCalled();
    expect(terminalError).not.toHaveBeenCalled();
  });

  it("records each active stage once for one invocation", async () => {
    const progress = vi.fn();
    const observe = createReleasedPythonTerminalFailureObserver({
      initialInvocation: 4,
      checkpoint: "python-entry",
      recordProgress: progress,
      terminalError: () => new Error("terminal")
    });

    await observe(diagnostics(5, "selecting-kernel", "selecting-kernel"));
    await observe(diagnostics(5, "selecting-kernel", "selecting-kernel"));
    await observe(diagnostics(5, "opening-variable", "opening-variable"));

    expect(progress.mock.calls).toEqual([
      ["python-entry:python-selecting-kernel"],
      ["python-entry:python-opening-variable"]
    ]);
  });

  it("resets stage progress when a newer invocation replaces the observed action", async () => {
    const progress = vi.fn();
    const observe = createReleasedPythonTerminalFailureObserver({
      initialInvocation: 4,
      checkpoint: "python-entry",
      recordProgress: progress,
      terminalError: () => new Error("terminal")
    });

    await observe(diagnostics(5, "selecting-kernel", "selecting-kernel"));
    await observe(diagnostics(6, "selecting-kernel", "selecting-kernel"));

    expect(progress).toHaveBeenCalledTimes(2);
  });

  it("publishes the failed checkpoint before awaiting bounded diagnostics and throwing", async () => {
    const order: string[] = [];
    const terminal = new Error("terminal failure");
    const observe = createReleasedPythonTerminalFailureObserver({
      initialInvocation: 4,
      checkpoint: "python-entry",
      recordProgress: (checkpoint) => order.push(`progress:${checkpoint}`),
      terminalError: async (value) => {
        order.push(`diagnostics:${value.stage}`);
        return terminal;
      }
    });

    await expect(observe(diagnostics(5, "failed", "opening-variable"))).rejects.toBe(terminal);
    expect(order).toEqual([
      "progress:python-entry:python-opening-variable",
      "progress:python-entry:python-opening-variable:failed",
      "diagnostics:failed"
    ]);
  });

  it("uses an explicit unknown-stage failure checkpoint", async () => {
    const progress: string[] = [];
    const observe = createReleasedPythonTerminalFailureObserver({
      initialInvocation: 0,
      checkpoint: "python-entry",
      recordProgress: (checkpoint) => progress.push(checkpoint),
      terminalError: () => new Error("terminal")
    });

    await expect(observe(diagnostics(1, "failed"))).rejects.toThrow("terminal");
    expect(progress).toEqual(["python-entry:python-unknown-stage:failed"]);
  });
});
