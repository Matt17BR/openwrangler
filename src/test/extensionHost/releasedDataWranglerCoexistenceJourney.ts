import * as assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Jupyter } from "@vscode/jupyter-extension";
import type { Browser, ElementHandle, Frame, Locator, Page } from "playwright-core";
import * as vscode from "vscode";
import { OPEN_WRANGLER_MIME_V2 } from "../../shared/notebookOutput";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import {
  DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT,
  writeDataWranglerCoexistenceNotebook
} from "./dataWranglerCoexistenceNotebookFixture";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import type { DataWranglerCoexistencePhase } from "./phaseDispatch";
import {
  ignoreRetiredRendererProbeFailure,
  isRetiredRendererTarget,
  withAcceptanceOperationDeadline
} from "./playwrightLifecycle";

interface ReleasedJupyterKernelTarget {
  readonly label: string;
  readonly name: string;
  readonly routeLabels: readonly string[];
  readonly remote?: {
    readonly baseUrl: vscode.Uri;
    readonly token: string;
    readonly runId: string;
    readonly hostname: string;
  };
}

interface OpenWranglerWebviewTarget {
  readonly page: Page;
  readonly frame: Frame;
}

export interface ReleasedDataWranglerCoexistenceJourneyDependencies {
  readonly NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS: number;
  readonly NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS: number;
  readonly NOTEBOOK_RENDERER_TARGET_LIMIT: number;
  readonly OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS: number;
  readonly RELEASED_JUPYTER_CONSENT_DETAIL: string;
  readonly RELEASED_JUPYTER_CONSENT_MESSAGE: string;
  readonly RELEASED_JUPYTER_EXTENSION_VERSION: string;
  readonly assertExactOpenNotebookDocument: (notebook: vscode.NotebookDocument, checkpoint: string) => void;
  readonly assertExactVisibleReleasedNotebookEditor: (
    notebook: vscode.NotebookDocument,
    editor: vscode.NotebookEditor,
    checkpoint: string
  ) => void;
  readonly assertNotebookRendererLifecycle: (workbench: Page, browser: Browser | null) => void;
  readonly bestEffortReleasedJupyterCleanup: (
    testing: TestApi,
    notebook: vscode.NotebookDocument | undefined,
    phase: DataWranglerCoexistencePhase
  ) => Promise<void>;
  readonly boundedImportPromptDiagnostics: (workbench: Page) => Promise<{ readonly dialogs: readonly string[] }>;
  readonly canonicalAcceptancePath: (candidate: string) => string;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    expectedText: string | readonly string[] | undefined,
    checkpoint: string,
    expectedEditor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly openWranglerWebviewTargets: (
    workbench: Page,
    browser: Browser | null,
    limit: number
  ) => readonly OpenWranglerWebviewTarget[];
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly releasedJupyterKernelTarget: (phase: DataWranglerCoexistencePhase) => ReleasedJupyterKernelTarget;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly restartReleasedJupyterKernelAndWait: (notebook: vscode.NotebookDocument) => Promise<void>;
  readonly selectReleasedJupyterKernel: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: DataWranglerCoexistencePhase,
    targetKernel: ReleasedJupyterKernelTarget
  ) => Promise<void>;
  readonly visibleReleasedJupyterConsentCount: (workbench: Page) => Promise<number>;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ readonly dialog: Locator; readonly allow: Locator; readonly deny: Locator }>;
}

const RELEASED_DATA_WRANGLER_EXTENSION_VERSION = "1.24.2";
const NOTEBOOK_PREVIEW_CONFLICT_MESSAGE =
  "Open Wrangler and Data Wrangler can both render dataframe outputs. Which notebook preview should take priority?";
const NOTEBOOK_PREVIEW_CONFLICT_DETAIL =
  "You can change this later with “Open Wrangler: Choose Notebook Preview Provider”.";
const NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER = "Use Open Wrangler";
const NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER = "Keep Data Wrangler";

export function createReleasedDataWranglerCoexistenceJourney({
  NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS,
  NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS,
  NOTEBOOK_RENDERER_TARGET_LIMIT,
  OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  RELEASED_JUPYTER_CONSENT_DETAIL,
  RELEASED_JUPYTER_CONSENT_MESSAGE,
  RELEASED_JUPYTER_EXTENSION_VERSION,
  assertExactOpenNotebookDocument,
  assertExactVisibleReleasedNotebookEditor,
  assertNotebookRendererLifecycle,
  bestEffortReleasedJupyterCleanup,
  boundedImportPromptDiagnostics,
  canonicalAcceptancePath,
  connectToEditorWorkbench,
  executeReleasedNotebookCell,
  openWranglerWebviewTargets,
  recordAcceptanceProgress,
  releasedJupyterKernelTarget,
  releasedNotebookJsonResult,
  restartReleasedJupyterKernelAndWait,
  selectReleasedJupyterKernel,
  visibleReleasedJupyterConsentCount,
  waitFor,
  waitForReleasedJupyterConsent
}: ReleasedDataWranglerCoexistenceJourneyDependencies): (
  testing: TestApi,
  extension: vscode.Extension<ExtensionApi>,
  phase: DataWranglerCoexistencePhase,
  testPython: string
) => Promise<void> {
  function dataWranglerCoexistenceExpectation(phase: DataWranglerCoexistencePhase): {
    provider: "openWrangler" | "dataWrangler";
    selection: boolean;
  } {
    return {
      provider: phase.includes("-open-") ? "openWrangler" : "dataWrangler",
      selection: phase.endsWith("-select")
    };
  }

  async function exerciseReleasedDataWranglerCoexistence(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    phase: DataWranglerCoexistencePhase,
    testPython: string
  ): Promise<void> {
    assert.equal(
      testing.diagnostics().sessionCount,
      0,
      "Data Wrangler coexistence acceptance must start without an Open Wrangler session."
    );
    assert.ok(
      !((extension.packageJSON.extensionDependencies as string[] | undefined) ?? []).includes("ms-toolsai.jupyter"),
      "Coexistence must not add a hard Jupyter dependency to Open Wrangler."
    );

    const jupyterExtension = vscode.extensions.getExtension<Jupyter>("ms-toolsai.jupyter");
    assert.ok(jupyterExtension, "The pinned released Microsoft Jupyter extension must be installed.");
    assert.equal(jupyterExtension.packageJSON.publisher, "ms-toolsai");
    assert.equal(jupyterExtension.packageJSON.name, "jupyter");
    assert.equal(jupyterExtension.packageJSON.version, RELEASED_JUPYTER_EXTENSION_VERSION);

    const dataWranglerExtension = vscode.extensions.getExtension("ms-toolsai.datawrangler");
    assert.ok(dataWranglerExtension, "The exact Microsoft Data Wrangler parity baseline must be installed.");
    assert.equal(dataWranglerExtension.packageJSON.publisher, "ms-toolsai");
    assert.equal(dataWranglerExtension.packageJSON.name, "datawrangler");
    assert.equal(
      dataWranglerExtension.packageJSON.version,
      RELEASED_DATA_WRANGLER_EXTENSION_VERSION,
      "Coexistence acceptance must not float to an unreviewed Data Wrangler version."
    );

    const expectation = dataWranglerCoexistenceExpectation(phase);
    if (expectation.provider === "dataWrangler") {
      await dataWranglerExtension.activate();
      assert.equal(dataWranglerExtension.isActive, true, "The selected real Data Wrangler extension must be active.");
    }
    const configuration = vscode.workspace.getConfiguration("openWrangler");
    const initialProvider = configuration.inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">(
      "notebookPreviewProvider"
    );
    if (expectation.selection) {
      assert.equal(
        initialProvider?.globalValue,
        undefined,
        "A fresh coexistence profile must not preselect a provider."
      );
      assert.equal(initialProvider?.workspaceValue, undefined);
      assert.equal(configuration.get("notebookPreviewProvider", "ask"), "ask");
    } else {
      assert.equal(
        initialProvider?.globalValue,
        expectation.provider,
        "A restart phase must seed its expected persisted provider globally."
      );
      assert.equal(configuration.get("notebookPreviewProvider", "ask"), expectation.provider);
    }

    const kernelTarget = releasedJupyterKernelTarget(phase);
    const directory = mkdtempSync(path.join(tmpdir(), `openwrangler-data-wrangler-${phase}-`));
    const notebookPath = path.join(directory, `${phase}.ipynb`);
    const ownershipSentinel = writeDataWranglerCoexistenceNotebook(notebookPath, kernelTarget);
    const notebookUri = vscode.Uri.file(notebookPath);
    let notebook: vscode.NotebookDocument | undefined;
    let firstOutputReceipt: DataWranglerFirstOutputReceipt | undefined;
    try {
      recordAcceptanceProgress(`${phase}:notebook-open`);
      notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      assertExactOpenNotebookDocument(notebook, "after opening the Data Wrangler coexistence fixture");
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      assert.equal(notebookEditor.notebook, notebook);
      assertExactVisibleReleasedNotebookEditor(
        notebook,
        notebookEditor,
        "after showing the Data Wrangler coexistence fixture"
      );

      const workbench = await connectToEditorWorkbench();
      if (expectation.selection) {
        assert.equal(
          configuration.get("notebookPreviewProvider", "ask"),
          "ask",
          "The conflict prompt must not mutate the preference before one explicit choice."
        );
        await assertNotebookPreviewConflictAbsent(
          workbench,
          750,
          "Provider selection must wait for one exact eligible dataframe output."
        );
      } else {
        recordAcceptanceProgress(`${phase}:provider-persisted`);
        await assertNotebookPreviewConflictAbsent(
          workbench,
          1_500,
          "A persisted notebook preview provider must suppress the conflict prompt after editor restart."
        );
      }

      recordAcceptanceProgress(`${phase}:kernel-discovery`);
      await jupyterExtension.activate();
      assertExactOpenNotebookDocument(notebook, "after activating released Jupyter for coexistence");
      recordAcceptanceProgress(`${phase}:kernel-select`);
      await selectReleasedJupyterKernel(workbench, notebook, notebookEditor, phase, kernelTarget);
      recordAcceptanceProgress(`${phase}:kernel-selected`);

      const firstExecution = executeReleasedNotebookCell(
        notebook,
        0,
        DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT,
        `${phase}:first-dataframe-cell`,
        notebookEditor
      );
      if (expectation.selection) {
        recordAcceptanceProgress(`${phase}:provider-prompt`);
        const conflict = await waitForNotebookPreviewConflict(workbench);
        await firstExecution;
        firstOutputReceipt = await captureDataWranglerFirstOutput(
          workbench,
          notebook,
          notebookEditor,
          ownershipSentinel
        );
        assert.equal(
          configuration.get("notebookPreviewProvider", "ask"),
          "ask",
          "The first physical dataframe output must remain unresolved until one explicit choice."
        );
        const action = expectation.provider === "openWrangler" ? conflict.useOpenWrangler : conflict.keepDataWrangler;
        await action.click();
        await conflict.dialog.waitFor({ state: "hidden", timeout: 10_000 });
        await waitFor(
          () =>
            vscode.workspace
              .getConfiguration("openWrangler")
              .inspect<"ask" | "openWrangler" | "dataWrangler" | "disabled">("notebookPreviewProvider")?.globalValue ===
            expectation.provider,
          10_000,
          "the selected notebook preview provider to persist globally"
        );
        await assertDataWranglerFirstOutputUnchanged(workbench, notebook, firstOutputReceipt, expectation.provider);
      } else {
        if (expectation.provider === "openWrangler") {
          recordAcceptanceProgress(`${phase}:open-wrangler-consent`);
          const consent = await waitForReleasedJupyterConsent(workbench, testing);
          await consent.allow.click();
          await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });
        }
        await firstExecution;
        await assertDataWranglerCoexistenceOutput(
          workbench,
          notebook,
          notebookEditor,
          ownershipSentinel,
          expectation.provider
        );
      }

      const firstExecutionKernel = dataWranglerCoexistenceFirstExecutionResult(notebook.cellAt(0));
      assert.equal(
        canonicalAcceptancePath(String(firstExecutionKernel.executable)),
        canonicalAcceptancePath(testPython),
        "Data Wrangler coexistence must use the private released-Jupyter interpreter."
      );
      assert.ok(Number.isSafeInteger(Number(firstExecutionKernel.pid)) && Number(firstExecutionKernel.pid) > 0);
      if (expectation.provider === "dataWrangler" && !expectation.selection) {
        assert.equal(
          await visibleReleasedJupyterConsentCount(workbench),
          0,
          "A persisted Data Wrangler provider must not show Open Wrangler kernel consent."
        );
      }

      await assertNotebookPreviewConflictAbsent(
        workbench,
        1_500,
        "The notebook preview conflict prompt must stay dismissed after the selected provider renders output."
      );

      if (!expectation.selection) {
        recordAcceptanceProgress(`${phase}:kernel-restart`);
        await restartReleasedJupyterKernelAndWait(notebook);
        await executeReleasedNotebookCell(
          notebook,
          0,
          DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT,
          `${phase}:restarted-dataframe-cell`,
          notebookEditor
        );
        const replacementKernel = dataWranglerCoexistenceFirstExecutionResult(notebook.cellAt(0));
        assert.notEqual(
          Number(replacementKernel.pid),
          Number(firstExecutionKernel.pid),
          "The coexistence restart phase must exercise a replacement kernel process."
        );
        assert.equal(
          canonicalAcceptancePath(String(replacementKernel.executable)),
          canonicalAcceptancePath(testPython)
        );
        await assertDataWranglerCoexistenceOutput(
          workbench,
          notebook,
          notebookEditor,
          ownershipSentinel,
          expectation.provider
        );
        await assertNotebookPreviewConflictAbsent(
          workbench,
          1_500,
          "Kernel restart must not repeat the resolved notebook preview conflict."
        );
      }

      assert.equal(
        testing.diagnostics().sessionCount,
        0,
        "Automatic notebook preview coexistence must not create an Open Wrangler session panel."
      );
    } finally {
      await firstOutputReceipt?.owner.dispose().catch(() => undefined);
      await firstOutputReceipt?.ordinaryTable.dispose().catch(() => undefined);
      await bestEffortReleasedJupyterCleanup(testing, notebook, phase);
      cleanupAcceptanceTemporaryDirectory(directory);
    }
  }

  interface DataWranglerFirstOutputReceipt {
    readonly cell: vscode.NotebookCell;
    readonly editor: vscode.NotebookEditor;
    readonly executionOrder: number;
    readonly outputCount: number;
    readonly output: vscode.NotebookCellOutput;
    readonly itemCount: number;
    readonly htmlItem: vscode.NotebookCellOutputItem;
    readonly dirty: boolean;
    readonly page: Page;
    readonly frame: Frame;
    readonly owner: ElementHandle<unknown>;
    readonly ordinaryTable: ElementHandle<unknown>;
  }

  type DataWranglerInlineOwner = Pick<DataWranglerFirstOutputReceipt, "page" | "frame" | "owner">;

  async function captureDataWranglerFirstOutput(
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    ownershipSentinel: string
  ): Promise<DataWranglerFirstOutputReceipt> {
    assertExactVisibleReleasedNotebookEditor(notebook, notebookEditor, "after its first physical dataframe output");
    const cell = notebook.cellAt(0);
    const executionOrder = cell.executionSummary?.executionOrder;
    assert.ok(
      Number.isSafeInteger(executionOrder) && executionOrder !== undefined && executionOrder > 0,
      "The first coexistence dataframe must have one positive execution order."
    );
    const htmlOutputs = cell.outputs.flatMap((output) =>
      output.items.filter((item) => item.mime === "text/html").map((htmlItem) => ({ output, htmlItem }))
    );
    assert.equal(htmlOutputs.length, 1, "The first dataframe must retain one ordinary HTML item.");
    const { output, htmlItem } = htmlOutputs[0]!;
    assert.equal(output.metadata?.outputType, "execute_result");
    assert.equal(
      cell.outputs.some((candidate) => candidate.items.some((item) => item.mime === OPEN_WRANGLER_MIME_V2)),
      false,
      "The ordinary first dataframe must not also contain Open Wrangler MIME."
    );
    const html = Buffer.from(htmlItem.data).toString("utf8");
    assert.ok(html.includes(ownershipSentinel), "The exact ordinary HTML item omitted its unique ownership sentinel.");
    const inlineOwner = await waitForConnectedInlineDataframeOwner(
      workbench,
      notebook,
      notebookEditor,
      cell,
      output,
      htmlItem,
      ownershipSentinel
    );
    const { page, frame, owner } = inlineOwner;
    const pendingTable = owner.evaluateHandle((value) =>
      (value as { querySelector(selector: string): unknown | null }).querySelector("table.dataframe")
    );
    let rawTable: Awaited<typeof pendingTable>;
    try {
      rawTable = await withAcceptanceOperationDeadline(
        pendingTable,
        NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS,
        "the exact first Pandas table handle"
      );
    } catch (error) {
      void pendingTable.then((handle) => handle.dispose()).catch(() => undefined);
      await owner.dispose().catch(() => undefined);
      throw error;
    }
    const ordinaryTable = rawTable.asElement() as ElementHandle<unknown> | null;
    if (!ordinaryTable) {
      await rawTable.dispose();
      await owner.dispose();
      assert.fail("The connected inline owner lost its exact ordinary Pandas table.");
    }
    assert.deepEqual(
      await withAcceptanceOperationDeadline(
        owner.evaluate((value) => {
          const element = value as {
            readonly isConnected: boolean;
            querySelector(selector: string): unknown | null;
          };
          return {
            connected: element.isConnected,
            ordinary: element.querySelector("table.dataframe") !== null,
            upgraded: element.querySelector('[data-open-wrangler-inline-upgrade="true"]') !== null
          };
        }),
        NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS,
        "the exact ordinary inline owner state"
      ),
      { connected: true, ordinary: true, upgraded: false }
    );
    return {
      cell,
      editor: notebookEditor,
      executionOrder,
      outputCount: cell.outputs.length,
      output,
      itemCount: output.items.length,
      htmlItem,
      dirty: notebook.isDirty,
      page,
      frame,
      owner,
      ordinaryTable
    };
  }

  async function waitForConnectedInlineDataframeOwner(
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    cell: vscode.NotebookCell,
    output: vscode.NotebookCellOutput,
    htmlItem: vscode.NotebookCellOutputItem,
    ownershipSentinel: string
  ): Promise<DataWranglerInlineOwner> {
    const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
    do {
      const browser = workbench.context().browser();
      assertNotebookRendererLifecycle(workbench, browser);
      assertExactVisibleReleasedNotebookEditor(notebook, notebookEditor, "while resolving its exact dataframe output");
      assert.equal(notebook.cellAt(0), cell, "Renderer discovery must retain the exact first dataframe cell.");
      assert.ok(cell.outputs.includes(output), "Renderer discovery must retain the exact dataframe output.");
      assert.ok(output.items.includes(htmlItem), "Renderer discovery must retain the exact ordinary HTML item.");

      const boundedTargets = openWranglerWebviewTargets(workbench, browser, NOTEBOOK_RENDERER_TARGET_LIMIT + 1);
      assert.ok(
        boundedTargets.length <= NOTEBOOK_RENDERER_TARGET_LIMIT,
        `Notebook renderer discovery exceeded its ${NOTEBOOK_RENDERER_TARGET_LIMIT}-target bound.`
      );
      const liveTargets = boundedTargets.filter(
        (target) => !isRetiredRendererTarget(workbench, target.page, target.frame)
      );
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const timeoutMs = Math.min(NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS, remainingMs);
      const probes = await Promise.allSettled(
        liveTargets.map((target) =>
          resolveExactDataWranglerInlineOwnerWithDeadline(target.frame, ownershipSentinel, timeoutMs)
        )
      );
      const matches: DataWranglerInlineOwner[] = [];
      let liveFailure: unknown;
      for (const [index, probe] of probes.entries()) {
        const target = liveTargets[index]!;
        if (probe.status === "rejected") {
          try {
            ignoreRetiredRendererProbeFailure(workbench, browser, target.page, target.frame, probe.reason);
          } catch (error) {
            liveFailure ??= error;
          }
          continue;
        }
        if (!probe.value) continue;
        if (isRetiredRendererTarget(workbench, target.page, target.frame)) {
          await probe.value.dispose().catch(() => undefined);
          continue;
        }
        matches.push({ page: target.page, frame: target.frame, owner: probe.value });
      }
      if (liveFailure !== undefined) {
        await Promise.allSettled(matches.map((match) => match.owner.dispose()));
        throw liveFailure;
      }
      if (matches.length > 1) {
        await Promise.allSettled(matches.map((match) => match.owner.dispose()));
        assert.fail("The exact notebook/editor/output owned more than one live inline renderer.");
      }
      if (matches.length === 1) {
        assertNotebookRendererLifecycle(workbench, browser);
        assertExactVisibleReleasedNotebookEditor(
          notebook,
          notebookEditor,
          "after resolving its exact dataframe output"
        );
        return matches[0]!;
      }
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error("Timed out waiting for the first Pandas HTML output's connected inline owner.");
  }

  async function resolveExactDataWranglerInlineOwnerWithDeadline(
    frame: Frame,
    ownershipSentinel: string,
    timeoutMs: number
  ): Promise<ElementHandle<unknown> | undefined> {
    const pending = resolveExactDataWranglerInlineOwner(frame, ownershipSentinel);
    try {
      return await withAcceptanceOperationDeadline(pending, timeoutMs, "the exact dataframe inline-owner probe");
    } catch (error) {
      void pending.then((owner) => owner?.dispose()).catch(() => undefined);
      throw error;
    }
  }

  async function resolveExactDataWranglerInlineOwner(
    frame: Frame,
    ownershipSentinel: string
  ): Promise<ElementHandle<unknown> | undefined> {
    const raw = await frame.evaluateHandle((expectedSentinel) => {
      type InlineDocument = InlineElement & { readonly readyState: string };
      type InlineElement = {
        readonly contentDocument?: InlineDocument | null;
        readonly isConnected: boolean;
        readonly textContent: string | null;
        querySelector(selector: string): InlineElement | null;
        querySelectorAll(selector: string): ArrayLike<InlineElement>;
      };
      const outer = (globalThis as unknown as { readonly document: InlineDocument }).document;
      const activeFrames = Array.from(outer.querySelectorAll("iframe#active-frame"));
      const pendingFrames = Array.from(outer.querySelectorAll("iframe#pending-frame"));
      if (activeFrames.length !== 1 || pendingFrames.length !== 0) return null;
      const activeFrame = activeFrames[0];
      const nested = activeFrame?.isConnected ? activeFrame.contentDocument : null;
      if (!nested || nested.readyState === "loading") return null;

      const owners = Array.from(nested.querySelectorAll("open-wrangler-inline-owner")).filter((owner) => {
        if (!owner.isConnected || owner.querySelector('[data-open-wrangler-inline-upgrade="true"]')) return false;
        const tables = Array.from(owner.querySelectorAll("table.dataframe"));
        return tables.length === 1 && tables[0]!.textContent?.includes(expectedSentinel) === true;
      });
      if (owners.length > 1) {
        throw new Error("One live renderer target contained duplicate owners for the exact dataframe output.");
      }
      return owners[0] ?? null;
    }, ownershipSentinel);
    const owner = raw.asElement() as ElementHandle<unknown> | null;
    if (owner) return owner;
    await raw.dispose();
    return undefined;
  }

  async function assertDataWranglerFirstOutputUnchanged(
    workbench: Page,
    notebook: vscode.NotebookDocument,
    receipt: DataWranglerFirstOutputReceipt,
    provider: "openWrangler" | "dataWrangler"
  ): Promise<void> {
    assertExactVisibleReleasedNotebookEditor(notebook, receipt.editor, "after resolving the notebook preview provider");
    assert.equal(notebook.cellAt(0), receipt.cell, "Provider rendering must retain the exact first dataframe cell.");
    assert.equal(
      receipt.cell.executionSummary?.executionOrder,
      receipt.executionOrder,
      "Provider rendering must not rerun the first dataframe cell."
    );
    assert.equal(receipt.cell.outputs.length, receipt.outputCount, "Provider rendering must not add an output.");
    assert.ok(
      receipt.cell.outputs.includes(receipt.output),
      "Provider rendering replaced the dataframe output object."
    );
    assert.equal(receipt.output.items.length, receipt.itemCount, "Provider rendering must not add an output item.");
    assert.ok(receipt.output.items.includes(receipt.htmlItem), "Provider rendering replaced the ordinary HTML item.");
    assert.equal(
      receipt.cell.outputs.some((output) => output.items.some((item) => item.mime === OPEN_WRANGLER_MIME_V2)),
      false,
      "The inline upgrade must not mutate the notebook output into Open Wrangler MIME."
    );
    assert.equal(notebook.isDirty, receipt.dirty, "Provider rendering must not dirty the notebook.");

    const deadline = Date.now() + NOTEBOOK_RENDERER_DISCOVERY_TIMEOUT_MS;
    do {
      assertExactVisibleReleasedNotebookEditor(notebook, receipt.editor, "while verifying provider rendering");
      let state:
        | {
            readonly owner: { readonly connected: boolean; readonly upgraded: boolean };
            readonly ordinaryConnected: boolean;
          }
        | undefined;
      try {
        const [owner, ordinaryConnected] = await withAcceptanceOperationDeadline(
          Promise.all([
            receipt.owner.evaluate((value) => {
              const element = value as {
                readonly isConnected: boolean;
                querySelector(selector: string): unknown | null;
              };
              return {
                connected: element.isConnected,
                upgraded: element.querySelector('[data-open-wrangler-inline-upgrade="true"]') !== null
              };
            }),
            receipt.ordinaryTable.evaluate((value) => (value as { readonly isConnected: boolean }).isConnected)
          ]),
          NOTEBOOK_RENDERER_PROBE_TIMEOUT_MS,
          "the retained first dataframe output state"
        );
        state = { owner, ordinaryConnected };
      } catch (error) {
        ignoreRetiredRendererProbeFailure(workbench, workbench.context().browser(), receipt.page, receipt.frame, error);
      }
      if (
        (provider === "openWrangler" && state?.owner.connected && state.owner.upgraded && !state.ordinaryConnected) ||
        (provider === "dataWrangler" && !state?.owner.connected && state?.ordinaryConnected)
      ) {
        return;
      }
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);
    throw new Error(
      provider === "openWrangler"
        ? "The exact first Pandas output owner did not replace its captured ordinary table inline."
        : "Declining Open Wrangler did not preserve the exact ordinary Pandas table."
    );
  }

  async function assertDataWranglerCoexistenceOutput(
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    ownershipSentinel: string,
    provider: "openWrangler" | "dataWrangler"
  ): Promise<void> {
    const cell = notebook.cellAt(0);
    const mimes = cell.outputs.flatMap((output) => output.items.map((item) => item.mime));
    if (provider === "openWrangler") {
      if (mimes.includes(OPEN_WRANGLER_MIME_V2)) return;
      const receipt = await captureDataWranglerFirstOutput(workbench, notebook, notebookEditor, ownershipSentinel);
      try {
        await assertDataWranglerFirstOutputUnchanged(workbench, notebook, receipt, provider);
      } finally {
        await receipt.owner.dispose().catch(() => undefined);
        await receipt.ordinaryTable.dispose().catch(() => undefined);
      }
      return;
    }
    assert.equal(
      mimes.includes(OPEN_WRANGLER_MIME_V2),
      false,
      "Choosing Data Wrangler must leave Open Wrangler's automatic notebook formatter unregistered."
    );
    assert.ok(
      mimes.includes("text/plain"),
      "The selected Data Wrangler path must retain the successful native Jupyter dataframe output."
    );
  }

  async function waitForNotebookPreviewConflict(workbench: Page): Promise<{
    dialog: Locator;
    useOpenWrangler: Locator;
    keepDataWrangler: Locator;
  }> {
    const deadline = Date.now() + OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS;
    let consentAccepted = false;
    do {
      const dialogs = workbench.mainFrame().locator(".monaco-dialog-box:visible");
      const dialogCount = await dialogs.count().catch(() => 0);
      assert.ok(dialogCount <= 1, "The first-output provider handoff must not expose simultaneous modal dialogs.");
      if (dialogCount === 1) {
        const dialog = dialogs.first();
        const message = await dialog.locator(".dialog-message-text").innerText();
        const detail = await dialog.locator(".dialog-message-detail").innerText();
        if (message === RELEASED_JUPYTER_CONSENT_MESSAGE) {
          assert.equal(consentAccepted, false, "Jupyter must not repeat kernel consent during one provider handoff.");
          assert.equal(detail, RELEASED_JUPYTER_CONSENT_DETAIL);
          const allow = dialog.getByRole("button", { name: "Allow", exact: true });
          assert.equal(await allow.count(), 1);
          consentAccepted = true;
          await allow.click();
          await dialog
            .filter({ hasText: RELEASED_JUPYTER_CONSENT_MESSAGE })
            .waitFor({ state: "hidden", timeout: Math.max(1, deadline - Date.now()) });
          continue;
        }
        assert.equal(message, NOTEBOOK_PREVIEW_CONFLICT_MESSAGE);
        assert.equal(detail, NOTEBOOK_PREVIEW_CONFLICT_DETAIL);
        const useOpenWrangler = dialog.getByRole("button", {
          name: NOTEBOOK_PREVIEW_USE_OPEN_WRANGLER,
          exact: true
        });
        const keepDataWrangler = dialog.getByRole("button", {
          name: NOTEBOOK_PREVIEW_KEEP_DATA_WRANGLER,
          exact: true
        });
        assert.equal(await useOpenWrangler.count(), 1);
        assert.equal(await keepDataWrangler.count(), 1);
        return { dialog, useOpenWrangler, keepDataWrangler };
      }
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);
    const diagnostics = await boundedImportPromptDiagnostics(workbench);
    throw new Error(
      `Timed out waiting for ${consentAccepted ? "the provider conflict" : "Jupyter kernel consent or the provider conflict"}. ` +
        `Dialogs: ${JSON.stringify(diagnostics.dialogs)}.`
    );
  }

  async function assertNotebookPreviewConflictAbsent(
    workbench: Page,
    observationMs: number,
    message: string
  ): Promise<void> {
    const deadline = Date.now() + observationMs;
    do {
      let count = 0;
      for (const frame of [workbench.mainFrame()]) {
        count += await frame
          .locator(".monaco-dialog-box:visible")
          .filter({ hasText: NOTEBOOK_PREVIEW_CONFLICT_MESSAGE })
          .count()
          .catch(() => 0);
      }
      assert.equal(count, 0, message);
      await workbench.waitForTimeout(50);
    } while (Date.now() < deadline);
  }

  function dataWranglerCoexistenceFirstExecutionResult(cell: vscode.NotebookCell): Record<string, unknown> {
    return releasedNotebookJsonResult(
      cell,
      DATA_WRANGLER_COEXISTENCE_FIRST_EXECUTION_RESULT,
      "Data Wrangler coexistence first execution"
    );
  }

  return exerciseReleasedDataWranglerCoexistence;
}
