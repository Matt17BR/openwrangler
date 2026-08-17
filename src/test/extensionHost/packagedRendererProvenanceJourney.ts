import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Frame, Page } from "playwright-core";
import { OPEN_WRANGLER_MIME_V2, type NotebookOutputPayload } from "../../shared/notebookOutput";
import {
  activateExactAcceptanceElementOnce,
  activateWithOnePreDispatchReacquisition,
  invokeAcceptanceActionOnceWithAuthoritativeReceipt,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";
import {
  bestEffortRendererProvenanceCleanup,
  createRendererProvenanceOrderContract,
  notebookTab,
  rendererProvenanceDiagnostics,
  rendererProvenanceTabs
} from "./rendererProvenance";
import type { TestApi } from "./extensionHostTestApi";

interface PackagedRendererProvenanceJupyterApi {
  readonly testing: {
    denialCalls(): number;
    lookupCalls(uri: vscode.Uri): number;
    stats(uri: vscode.Uri): { readonly generation: number; readonly executions: number } | undefined;
  };
}

type FakeJupyterApi = PackagedRendererProvenanceJupyterApi;

interface PackagedRendererButton {
  readonly page: Page;
  readonly frame: Frame;
  scrollIntoViewIfNeeded(options?: { readonly timeout?: number }): Promise<void>;
  click(options?: { readonly force?: boolean; readonly timeout?: number }): Promise<void>;
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
  dispose(): Promise<void>;
}

export interface PackagedRendererProvenanceDependencies {
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly isOpenWranglerSessionTab: (tab: vscode.Tab) => boolean;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterSessionTabs: () => vscode.Tab[];
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForNotebookRendererButton: (
    workbench: Page,
    label: string,
    buttonName?: string
  ) => Promise<PackagedRendererButton>;
  readonly waitForNotebookRendererPreviewOnly: (workbench: Page, label: string) => Promise<void>;
  readonly gridColumnWindow: { readonly columnOffset: number; readonly columnLimit: number };
  readonly sessionOpenAcceptanceTimeoutMs: number;
  readonly workbenchPlaywrightTimeoutMs: number;
}

export function createPackagedRendererProvenanceJourneys(dependencies: PackagedRendererProvenanceDependencies): {
  readonly exercisePackagedRendererProvenance: (
    testing: TestApi,
    jupyter: PackagedRendererProvenanceJupyterApi,
    originNotebook: vscode.NotebookDocument,
    payloadTemplate: NotebookOutputPayload,
    directory: string
  ) => Promise<void>;
  readonly exercisePackagedSameGroupRendererSwitch: (
    jupyter: PackagedRendererProvenanceJupyterApi,
    originNotebook: vscode.NotebookDocument,
    payloadTemplate: NotebookOutputPayload,
    directory: string
  ) => Promise<void>;
} {
  const {
    connectToEditorWorkbench,
    disposePackagedSessionPanel,
    isOpenWranglerSessionTab,
    recordAcceptanceProgress,
    releasedJupyterSessionTabs,
    waitFor,
    waitForNotebookRendererButton,
    waitForNotebookRendererPreviewOnly,
    gridColumnWindow,
    sessionOpenAcceptanceTimeoutMs,
    workbenchPlaywrightTimeoutMs
  } = dependencies;
  const GRID_COLUMN_WINDOW = gridColumnWindow;
  const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = sessionOpenAcceptanceTimeoutMs;
  const WORKBENCH_PLAYWRIGHT_TIMEOUT_MS = workbenchPlaywrightTimeoutMs;

  async function exercisePackagedSameGroupRendererSwitch(
    jupyter: FakeJupyterApi,
    originNotebook: vscode.NotebookDocument,
    payloadTemplate: NotebookOutputPayload,
    directory: string
  ): Promise<void> {
    const label = "same-group renderer switch";
    const notebookPath = path.join(directory, "renderer-same-group.ipynb");
    const payload: NotebookOutputPayload = {
      ...payloadTemplate,
      metadata: {
        ...payloadTemplate.metadata,
        sessionId: "snapshot-renderer-same-group",
        source: { kind: "notebookOutput", label }
      }
    };
    writeFileSync(
      notebookPath,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            execution_count: 1,
            metadata: {},
            outputs: [
              {
                output_type: "display_data",
                metadata: {},
                data: {
                  "text/plain": [`Open Wrangler ${label}`],
                  [OPEN_WRANGLER_MIME_V2]: payload
                }
              }
            ],
            source: ["# saved renderer switch"]
          }
        ],
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
        nbformat: 4,
        nbformat_minor: 5
      })
    );

    let switchedNotebook: vscode.NotebookDocument | undefined;
    try {
      recordAcceptanceProgress("verify:notebook-renderer-same-group:connect");
      const workbench = await connectToEditorWorkbench();
      recordAcceptanceProgress("verify:notebook-renderer-same-group:open");
      switchedNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(notebookPath));
      const switchedEditor = await vscode.window.showNotebookDocument(switchedNotebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      switchedEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
      recordAcceptanceProgress("verify:notebook-renderer-same-group:preview-only");
      await waitForNotebookRendererPreviewOnly(workbench, label);
      assert.equal(
        jupyter.testing.stats(switchedNotebook.uri),
        undefined,
        "Switching to a saved-output notebook must not acquire a Jupyter kernel."
      );

      const switchedTab = notebookTab(switchedNotebook.uri);
      assert.ok(switchedTab, "The same-group renderer fixture tab must be open.");
      recordAcceptanceProgress("verify:notebook-renderer-same-group:close");
      assert.equal(await vscode.window.tabGroups.close(switchedTab, true), true);
      recordAcceptanceProgress("verify:notebook-renderer-same-group:restore");
      await vscode.window.showNotebookDocument(originNotebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      recordAcceptanceProgress("verify:notebook-renderer-same-group:restored-button");
      await (
        await waitForNotebookRendererButton(workbench, "renderer provenance A", "Open in Open Wrangler")
      ).dispose();
      recordAcceptanceProgress("verify:notebook-renderer-same-group:complete");
    } finally {
      const switchedTab = switchedNotebook ? notebookTab(switchedNotebook.uri) : undefined;
      if (switchedTab) await vscode.window.tabGroups.close(switchedTab, true).then(undefined, () => undefined);
    }
  }

  async function exercisePackagedRendererProvenance(
    testing: TestApi,
    jupyter: FakeJupyterApi,
    originNotebook: vscode.NotebookDocument,
    payloadTemplate: NotebookOutputPayload,
    directory: string
  ): Promise<void> {
    recordAcceptanceProgress("verify:notebook-renderer:fixtures");
    const secondNotebookPath = path.join(directory, "renderer-provenance-b.ipynb");
    const secondPayload: NotebookOutputPayload = {
      ...payloadTemplate,
      metadata: {
        ...payloadTemplate.metadata,
        sessionId: "snapshot-renderer-provenance-b",
        source: {
          kind: "notebookOutput",
          label: "renderer provenance B",
          variableName: "renderer_frame"
        }
      }
    };
    writeFileSync(
      secondNotebookPath,
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            execution_count: 1,
            metadata: {},
            outputs: [
              {
                output_type: "display_data",
                metadata: {},
                data: {
                  "text/plain": [`Open Wrangler ${secondPayload.metadata.source.label}`],
                  [OPEN_WRANGLER_MIME_V2]: secondPayload
                }
              }
            ],
            source: ["renderer_frame"]
          }
        ],
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
        nbformat: 4,
        nbformat_minor: 5
      })
    );
    recordAcceptanceProgress("verify:notebook-renderer:fixture-written");

    let secondNotebook: vscode.NotebookDocument | undefined;
    const provenanceOrder = createRendererProvenanceOrderContract();
    try {
      recordAcceptanceProgress("verify:notebook-renderer:open-b");
      const openedSecondNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(secondNotebookPath));
      secondNotebook = openedSecondNotebook;
      recordAcceptanceProgress("verify:notebook-renderer:opened-b");
      assert.equal(
        jupyter.testing.lookupCalls(openedSecondNotebook.uri),
        0,
        "Opening notebook B through the API without a visible editor must not start proactive formatter work."
      );
      assert.equal(
        jupyter.testing.stats(openedSecondNotebook.uri),
        undefined,
        "An API-opened background notebook must not start or execute a kernel."
      );
      recordAcceptanceProgress("verify:notebook-renderer:show-a");
      const originEditor = await vscode.window.showNotebookDocument(originNotebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      originEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
      recordAcceptanceProgress("verify:notebook-renderer:show-b");
      await vscode.window.showNotebookDocument(openedSecondNotebook, {
        viewColumn: vscode.ViewColumn.Two,
        preserveFocus: false,
        preview: false
      });
      recordAcceptanceProgress("verify:notebook-renderer:shown-b");
      provenanceOrder.secondNotebookShown();
      recordAcceptanceProgress("verify:notebook-renderer:reveal-a-after-split");
      originEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
      provenanceOrder.originRevealed();
      const originKernelBaseline = jupyter.testing.stats(originNotebook.uri);
      const secondKernelBaseline = jupyter.testing.stats(openedSecondNotebook.uri);
      assert.equal(
        vscode.window.activeNotebookEditor?.notebook,
        openedSecondNotebook,
        "Notebook B must remain active while the renderer event is emitted from notebook A."
      );
      provenanceOrder.secondNotebookActive();

      recordAcceptanceProgress("verify:notebook-renderer:button");
      const workbench = await connectToEditorWorkbench();
      await withAcceptanceOperationDeadline(
        workbench.bringToFront(),
        WORKBENCH_PLAYWRIGHT_TIMEOUT_MS,
        "the private editor workbench to come to front before renderer-action discovery"
      );
      assert.equal(
        vscode.window.activeNotebookEditor?.notebook,
        openedSecondNotebook,
        "Notebook B must still be the exact active document immediately before notebook A's renderer action."
      );
      assert.equal(testing.activeSession(), undefined);
      assert.equal(
        testing.diagnostics().sessionCount,
        0,
        "The renderer provenance action requires zero coordinator sessions for its authoritative receipt."
      );
      assert.equal(
        releasedJupyterSessionTabs().length,
        0,
        "The renderer provenance action requires zero Open Wrangler tabs for its authoritative receipt."
      );
      const originLookupBaseline = jupyter.testing.lookupCalls(originNotebook.uri);
      const secondLookupBaseline = jupyter.testing.lookupCalls(openedSecondNotebook.uri);
      const denialBaseline = jupyter.testing.denialCalls();
      const waitForOriginReceipt = async (recordSessionCheckpoint: boolean): Promise<void> => {
        if (recordSessionCheckpoint) recordAcceptanceProgress("verify:notebook-renderer:session");
        await waitFor(
          () => {
            const source = testing.activeSession()?.metadata.source;
            return (
              source?.kind === "notebookVariable" &&
              source.variableName === "renderer_frame" &&
              source.uri === originNotebook.uri.toString()
            );
          },
          SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
          "notebook A's primary renderer action to open notebook A's live renderer_frame while notebook B is active",
          () => rendererProvenanceDiagnostics(testing, jupyter, originNotebook, openedSecondNotebook)
        );
      };
      recordAcceptanceProgress("verify:notebook-renderer:activate");
      provenanceOrder.actionDiscoveryStarted();
      try {
        await invokeAcceptanceActionOnceWithAuthoritativeReceipt({
          description: "notebook A's renderer action while notebook B is active",
          activate: () =>
            activateWithOnePreDispatchReacquisition({
              acquire: () => waitForNotebookRendererButton(workbench, "renderer provenance A", "Open in Open Wrangler"),
              activate: (button) =>
                activateExactAcceptanceElementOnce(button, WORKBENCH_PLAYWRIGHT_TIMEOUT_MS, () => {
                  provenanceOrder.clickBoundaryEntered();
                  assert.equal(
                    vscode.window.activeNotebookEditor?.notebook,
                    openedSecondNotebook,
                    "Notebook B must still be active at notebook A's renderer-action boundary."
                  );
                  recordAcceptanceProgress("verify:notebook-renderer:click-boundary");
                }),
              dispose: (button) => button.dispose()
            }),
          receipt: () => waitForOriginReceipt(true),
          authoritativeReceiptAfterActivationFailure: () => waitForOriginReceipt(false)
        });
        provenanceOrder.actionReceipted();
      } catch (error) {
        if (!(error instanceof AggregateError)) throw error;
        const activationFailure = error.errors[0];
        const activationCause =
          activationFailure instanceof Error ? (activationFailure.cause ?? activationFailure) : null;
        const activationSummary =
          activationCause instanceof Error
            ? `${activationCause.name}: ${activationCause.message}`.replaceAll(/\s+/gu, " ").trim().slice(0, 512)
            : "unknown activation failure";
        throw new Error(
          `${error.message} Activation stage: click boundary ${provenanceOrder.clickBoundaryWasEntered ? "entered" : "not entered"}. ` +
            `Activation cause: ${activationSummary}. ` +
            `Receipt state: ${rendererProvenanceDiagnostics(testing, jupyter, originNotebook, openedSecondNotebook)}`,
          { cause: error }
        );
      }

      const active = testing.activeSession();
      assert.ok(active, "The renderer provenance scenario must open the exact live notebook-variable session.");
      assert.equal(active.metadata.backend, "polars");
      assert.deepEqual(active.metadata.source, {
        kind: "notebookVariable",
        label: "renderer_frame",
        variableName: "renderer_frame",
        uri: originNotebook.uri.toString()
      });
      assert.equal(active.metadata.mode, "editing");
      assert.deepEqual(active.metadata.shape, { rows: 1, columns: 1 });
      assert.deepEqual(active.metadata.filteredShape, { rows: 1, columns: 1 });
      assert.equal(active.metadata.capabilities.editable, true);
      assert.equal(active.metadata.capabilities.notebookInsert, true);
      const provenancePage = await testing.request({
        kind: "getPage",
        ...GRID_COLUMN_WINDOW,
        viewRequestId: "notebook-renderer-provenance-page",
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        offset: 0,
        limit: 10,
        filterModel: active.metadata.filterModel
      });
      assert.equal(provenancePage.kind, "page");
      if (provenancePage.kind !== "page") throw new Error("Renderer provenance page did not resolve.");
      assert.equal(
        provenancePage.page.rows[0]?.values[0]?.display,
        "101",
        "The primary renderer action must use notebook A's current live renderer_frame, not its captured value or notebook B."
      );
      assert.ok(
        (jupyter.testing.stats(originNotebook.uri)?.executions ?? 0) > (originKernelBaseline?.executions ?? 0),
        "Opening a linked renderer output must dispatch the live request to notebook A's exact kernel."
      );
      assert.deepEqual(
        jupyter.testing.stats(openedSecondNotebook.uri),
        secondKernelBaseline,
        "Opening notebook A's live variable must not dispatch work to notebook B's kernel."
      );
      assert.ok(
        jupyter.testing.lookupCalls(originNotebook.uri) > originLookupBaseline,
        "The primary renderer action must acquire notebook A's exact kernel."
      );
      assert.equal(
        jupyter.testing.lookupCalls(openedSecondNotebook.uri),
        secondLookupBaseline,
        "The primary renderer action must not acquire notebook B's kernel."
      );
      assert.equal(
        jupyter.testing.denialCalls(),
        denialBaseline,
        "The already-authorized primary renderer action must not request a second Jupyter permission."
      );

      recordAcceptanceProgress("verify:notebook-renderer:session-close");
      await disposePackagedSessionPanel(testing, active.sessionId, "the live renderer provenance session");
      await waitFor(() => testing.diagnostics().sessionCount === 0, 10_000, "the renderer provenance session to close");
      recordAcceptanceProgress("verify:notebook-renderer:tabs-close");
      const tabsToClose = rendererProvenanceTabs(openedSecondNotebook, isOpenWranglerSessionTab);
      if (tabsToClose.length > 0) assert.equal(await vscode.window.tabGroups.close(tabsToClose, true), true);
      recordAcceptanceProgress("verify:notebook-renderer:complete");
    } catch (error) {
      await bestEffortRendererProvenanceCleanup(testing, secondNotebook, isOpenWranglerSessionTab);
      throw error;
    }
  }

  return { exercisePackagedRendererProvenance, exercisePackagedSameGroupRendererSwitch };
}
