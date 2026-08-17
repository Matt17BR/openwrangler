import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { TestApi } from "./extensionHostTestApi";

export interface PackagedSessionPanelLifecycleDependencies {
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
}

export function createPackagedSessionPanelLifecycle(dependencies: PackagedSessionPanelLifecycleDependencies): {
  readonly closeReleasedJupyterSessionTabs: () => Promise<void>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly isOpenWranglerSessionTab: (tab: vscode.Tab) => boolean;
  readonly releasedJupyterSessionTabs: () => vscode.Tab[];
} {
  const { waitFor } = dependencies;

  async function closeReleasedJupyterSessionTabs(): Promise<void> {
    const tabs = releasedJupyterSessionTabs();
    if (tabs.length > 0) await vscode.window.tabGroups.close(tabs, true);
  }

  function releasedJupyterSessionTabs(): vscode.Tab[] {
    return vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isOpenWranglerSessionTab);
  }

  function isOpenWranglerSessionTab(tab: vscode.Tab): boolean {
    const input = tab.input;
    return (
      tab.label.startsWith("Open Wrangler: ") ||
      (typeof input === "object" &&
        input !== null &&
        "viewType" in input &&
        (input as { viewType?: unknown }).viewType === "openWrangler.session")
    );
  }

  async function disposePackagedSessionPanel(testing: TestApi, sessionId: string, description: string): Promise<void> {
    const openTabCount = releasedJupyterSessionTabs().length;
    const response = await testing.disposePanelForSession(sessionId);
    assert.equal(response?.kind, "sessionClosed", `${description} panel must close authoritatively.`);
    if (response?.kind === "sessionClosed") assert.equal(response.sessionId, sessionId);
    await waitFor(
      () => !testing.diagnostics().sessions.some((session) => session.publicId === sessionId),
      10_000,
      `${description} to leave the coordinator`
    );
    if (openTabCount > 0) {
      await waitFor(
        () => releasedJupyterSessionTabs().length < openTabCount,
        10_000,
        `${description} editor tab to close`
      );
    }
  }

  return {
    closeReleasedJupyterSessionTabs,
    disposePackagedSessionPanel,
    isOpenWranglerSessionTab,
    releasedJupyterSessionTabs
  };
}
