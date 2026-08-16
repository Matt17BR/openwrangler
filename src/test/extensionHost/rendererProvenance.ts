import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { OpenWranglerRequest, OpenWranglerResponse, SessionMetadata } from "../../shared/protocol";

interface RendererProvenanceSession {
  readonly sessionId: string;
  readonly metadata: Pick<SessionMetadata, "revision" | "source">;
}

export interface RendererProvenanceTesting {
  activeSession(): RendererProvenanceSession | undefined;
  diagnostics(): Readonly<{ sessionCount: number; activeSessionId?: string }>;
  request(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
}

export interface RendererProvenanceJupyter {
  readonly testing: Readonly<{
    stats(uri: vscode.Uri): unknown;
    lookupCalls(uri: vscode.Uri): number;
    denialCalls(): number;
  }>;
}

type RendererProvenanceStage =
  | "initial"
  | "second-notebook-shown"
  | "origin-revealed"
  | "second-notebook-active"
  | "action-discovery"
  | "click-boundary"
  | "receipted";

export interface RendererProvenanceOrderContract {
  secondNotebookShown(): void;
  originRevealed(): void;
  secondNotebookActive(): void;
  actionDiscoveryStarted(): void;
  clickBoundaryEntered(): void;
  actionReceipted(): void;
  readonly clickBoundaryWasEntered: boolean;
}

export function createRendererProvenanceOrderContract(): RendererProvenanceOrderContract {
  let stage: RendererProvenanceStage = "initial";
  const advance = (expected: RendererProvenanceStage, next: RendererProvenanceStage): void => {
    assert.equal(stage, expected, `Renderer provenance expected ${expected} before ${next}; observed ${stage}.`);
    stage = next;
  };
  return {
    secondNotebookShown: () => advance("initial", "second-notebook-shown"),
    originRevealed: () => advance("second-notebook-shown", "origin-revealed"),
    secondNotebookActive: () => advance("origin-revealed", "second-notebook-active"),
    actionDiscoveryStarted: () => advance("second-notebook-active", "action-discovery"),
    clickBoundaryEntered: () => advance("action-discovery", "click-boundary"),
    actionReceipted: () => advance("click-boundary", "receipted"),
    get clickBoundaryWasEntered(): boolean {
      return stage === "click-boundary" || stage === "receipted";
    }
  };
}

export function rendererProvenanceDiagnostics(
  testing: RendererProvenanceTesting,
  jupyter: RendererProvenanceJupyter,
  originNotebook: vscode.NotebookDocument,
  secondNotebook: vscode.NotebookDocument
): string {
  const activeNotebook = vscode.window.activeNotebookEditor?.notebook;
  const source = testing.activeSession()?.metadata.source;
  const coordinator = testing.diagnostics();
  const sourceDiagnostic =
    source?.kind === "notebookVariable"
      ? {
          kind: source.kind,
          variableName: source.variableName,
          origin:
            source.uri === originNotebook.uri.toString()
              ? "A"
              : source.uri === secondNotebook.uri.toString()
                ? "B"
                : "other"
        }
      : source
        ? { kind: source.kind, label: source.label }
        : null;
  return JSON.stringify({
    activeNotebook:
      activeNotebook === originNotebook
        ? "A"
        : activeNotebook === secondNotebook
          ? "B"
          : activeNotebook
            ? "other"
            : "none",
    activeSource: sourceDiagnostic,
    coordinator: {
      sessionCount: coordinator.sessionCount,
      activeSessionPresent: coordinator.activeSessionId !== undefined
    },
    kernels: {
      A: {
        stats: jupyter.testing.stats(originNotebook.uri) ?? null,
        lookupCalls: jupyter.testing.lookupCalls(originNotebook.uri)
      },
      B: {
        stats: jupyter.testing.stats(secondNotebook.uri) ?? null,
        lookupCalls: jupyter.testing.lookupCalls(secondNotebook.uri)
      }
    },
    jupyterDenialCalls: jupyter.testing.denialCalls()
  });
}

export async function bestEffortRendererProvenanceCleanup(
  testing: RendererProvenanceTesting,
  secondNotebook: vscode.NotebookDocument | undefined,
  isSessionTab: (tab: vscode.Tab) => boolean
): Promise<void> {
  const active = testing.activeSession();
  if (active?.metadata.source.kind === "notebookVariable" && active.metadata.source.variableName === "renderer_frame") {
    try {
      await testing.request({
        kind: "closeSession",
        sessionId: active.sessionId,
        revision: active.metadata.revision
      });
    } catch {
      // Editor-process-group teardown remains the final bounded fallback.
    }
  }
  const tabsToClose = rendererProvenanceTabs(secondNotebook, isSessionTab);
  if (tabsToClose.length > 0) {
    try {
      await vscode.window.tabGroups.close(tabsToClose, true);
    } catch {
      // Preserve the original acceptance failure.
    }
  }
}

export function rendererProvenanceTabs(
  secondNotebook: vscode.NotebookDocument | undefined,
  isSessionTab: (tab: vscode.Tab) => boolean
): vscode.Tab[] {
  return [
    ...(secondNotebook ? [notebookTab(secondNotebook.uri)] : []),
    ...vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.label === "Open Wrangler: renderer provenance A" || isSessionTab(tab))
  ].filter((tab): tab is vscode.Tab => Boolean(tab));
}

export function notebookTab(uri: vscode.Uri): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputNotebook && tab.input.uri.toString() === uri.toString());
}
