import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { commands } from "vscode";
import { revealSideBar, trackSideBarViews } from "../extension/sideBarReveal";

function sideBarView(visible: boolean) {
  const listeners = new Set<(event: vscode.TreeViewVisibilityChangeEvent) => void>();
  return {
    visible,
    onDidChangeVisibility: (listener: (event: vscode.TreeViewVisibilityChangeEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    setVisible(next: boolean) {
      this.visible = next;
      for (const listener of listeners) listener({ visible: next });
    }
  };
}

describe("side bar reveal", () => {
  let tracking: vscode.Disposable | undefined;
  afterEach(() => {
    tracking?.dispose();
    vi.restoreAllMocks();
  });

  it("reopens a view the user left expanded, or the first view before any was shown", () => {
    const executeCommand = vi.spyOn(commands, "executeCommand");
    const dataSources = sideBarView(false);
    const operations = sideBarView(false);
    const summary = sideBarView(false);
    tracking = trackSideBarViews([
      ["openWrangler.dataSources", dataSources],
      ["openWrangler.operations", operations],
      ["openWrangler.summary", summary]
    ]);
    revealSideBar();
    expect(executeCommand).toHaveBeenLastCalledWith("openWrangler.dataSources.open", { preserveFocus: true });

    dataSources.setVisible(true);
    summary.setVisible(true);
    dataSources.setVisible(false);
    summary.setVisible(false);
    revealSideBar();
    expect(executeCommand).toHaveBeenLastCalledWith("openWrangler.summary.open", { preserveFocus: true });

    tracking.dispose();
    executeCommand.mockClear();
    revealSideBar();
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("reports a reveal the editor rejects", async () => {
    vi.spyOn(commands, "executeCommand").mockRejectedValue(new Error("view unavailable"));
    const reportDiagnostic = vi.fn();
    tracking = trackSideBarViews([["openWrangler.dataSources", sideBarView(false)]]);

    revealSideBar(reportDiagnostic);

    await vi.waitFor(() =>
      expect(reportDiagnostic).toHaveBeenCalledWith("Open Wrangler could not show its side bar: view unavailable")
    );
  });
});
