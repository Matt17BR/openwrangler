import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Frame, Page } from "playwright-core";
import * as vscode from "vscode";
import { OPEN_WRANGLER_MIME_V2, type NotebookOutputPayload } from "../../shared/notebookOutput";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import type { ExtensionApi, TestApi } from "./extensionHostTestApi";
import { notebookTab } from "./rendererProvenance";
import { PACKAGED_FIRST_USE_ROW_COUNT, PACKAGED_SCREENSHOT_COLUMNS } from "./screenshotEvidence";

interface PackagedDailyCoreGridTarget {
  readonly frame: Frame;
}

interface PackagedDailyCoreRendererButton {
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
  dispose(): Promise<void>;
}

export interface PackagedDailyCoreJourneyDependencies {
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForAutomaticDelimitedImport: (
    page: Page,
    testing: TestApi,
    expectedSource: vscode.Uri,
    checkpointPrefix: string
  ) => Promise<void>;
  readonly waitForNotebookRendererButton: (
    workbench: Page,
    label: string,
    buttonLabel: string
  ) => Promise<PackagedDailyCoreRendererButton>;
  readonly waitForOpenWranglerGridTarget: (
    workbench: Page,
    testing: TestApi,
    expectedSessionId: string
  ) => Promise<PackagedDailyCoreGridTarget>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: Thenable<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
  readonly SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS: number;
}

export function createPackagedDailyCoreJourney({
  connectToEditorWorkbench,
  recordAcceptanceProgress,
  waitFor,
  waitForAutomaticDelimitedImport,
  waitForNotebookRendererButton,
  waitForOpenWranglerGridTarget,
  withBoundedAcceptancePromise,
  SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS
}: PackagedDailyCoreJourneyDependencies) {
  return async function exercisePackagedDailyCore(
    testing: TestApi,
    extension: vscode.Extension<ExtensionApi>,
    fixture: vscode.Uri
  ): Promise<void> {
    assert.equal(
      process.env.OPEN_WRANGLER_TEST_EDITOR,
      "vscode",
      "The daily preview journey runs in the representative VS Code editor."
    );
    assert.equal(testing.diagnostics().sessionCount, 0, "The daily preview journey must start without a session.");
    const sourceBytes = await vscode.workspace.fs.readFile(fixture);
    const notebookDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-daily-index-"));
    const notebookLabel = "daily Pandas index preview";
    const notebookPath = path.join(notebookDirectory, "pandas-index.ipynb");
    const notebookUri = vscode.Uri.file(notebookPath);
    const failures: unknown[] = [];
    let editorMayBeOpen = false;

    try {
      const notebookPayload: NotebookOutputPayload = {
        mimeVersion: 2,
        metadata: {
          protocolVersion: 2,
          sessionId: "daily-pandas-index-snapshot",
          revision: 0,
          backend: "pandas",
          mode: "viewing",
          source: {
            kind: "notebookOutput",
            label: notebookLabel,
            variableName: "daily_index_frame"
          },
          capabilities: {
            editable: false,
            lazy: false,
            cancel: false,
            exportCsv: false,
            exportParquet: false,
            notebookInsert: false
          },
          shape: { rows: 1, columns: 1 },
          filteredShape: { rows: 1, columns: 1 },
          schema: [{ id: "c:value", name: "value", position: 0, rawType: "int64", type: "integer", nullable: false }],
          rowAxis: { kind: "index", levelNames: ["sample_id"] },
          filterModel: { filters: [], sort: [] },
          steps: []
        },
        page: {
          offset: 0,
          limit: 1,
          totalRows: 1,
          columnIds: ["c:value"],
          rows: [
            {
              id: "r:0",
              rowNumber: 0,
              rowLabel: "SP0230700005-1",
              values: [{ kind: "integer", raw: 1, display: "1", isNull: false, isNaN: false }]
            }
          ]
        },
        summaries: []
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
                    "text/plain": ["Open Wrangler saved Pandas index output"],
                    [OPEN_WRANGLER_MIME_V2]: notebookPayload
                  }
                }
              ],
              source: ["daily_index_frame"]
            }
          ],
          metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
          nbformat: 4,
          nbformat_minor: 5
        })
      );

      const page = await connectToEditorWorkbench();
      const activeEditorGroup = page.locator(".part.editor .editor-group-container.active");
      recordAcceptanceProgress("platform-smoke:daily-core:open-csv");
      editorMayBeOpen = true;
      await vscode.commands.executeCommand("vscode.open", fixture, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
      });
      await waitFor(
        () => {
          const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
          return input instanceof vscode.TabInputText && input.uri.toString() === fixture.toString();
        },
        10_000,
        "the CSV source editor before its Open Wrangler title action"
      );
      await page.bringToFront();
      const titleAction = activeEditorGroup
        .locator('.editor-actions [aria-label="Open in Open Wrangler"]:visible')
        .first();
      await titleAction.waitFor({ state: "visible", timeout: 10_000 });
      await titleAction.click();
      await waitForAutomaticDelimitedImport(page, testing, fixture, "platform-smoke:daily-core:import");
      await waitFor(
        () => testing.activeSession()?.metadata.source.uri === fixture.toString(),
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the public CSV action to open a dataframe session"
      );

      const active = testing.activeSession();
      assert.ok(active, "The daily preview journey must publish an active dataframe session.");
      assert.equal(extension.isActive, true, "Opening the CSV must activate the installed extension.");
      assert.equal(active.metadata.backend, "polars");
      assert.deepEqual(active.metadata.shape, {
        rows: PACKAGED_FIRST_USE_ROW_COUNT,
        columns: PACKAGED_SCREENSHOT_COLUMNS.length
      });

      recordAcceptanceProgress("platform-smoke:daily-core:grid");
      const target = await waitForOpenWranglerGridTarget(page, testing, active.metadata.sessionId);
      const grid = target.frame.getByRole("grid", { name: `Data grid for ${active.metadata.source.label}` });
      await grid.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await grid.getAttribute("aria-colcount"), String(PACKAGED_SCREENSHOT_COLUMNS.length + 1));
      const firstCell = target.frame.locator('td[data-grid-row="0"][data-grid-column="0"]').first();
      await firstCell.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal((await firstCell.innerText()).trim(), "2400001");

      recordAcceptanceProgress("platform-smoke:daily-core:sort");
      const marketHeader = target.frame.locator('th[data-column="market"]').first();
      const marketMenu = marketHeader.locator("details.columnMenu").first();
      await marketMenu.getByLabel("Column actions for market").click();
      await marketMenu.getByRole("button", { name: "Sort descending", exact: true }).click();
      await waitFor(
        () => {
          const sort = testing.activeSession()?.viewState.filterModel.sort;
          return (
            sort?.length === 1 &&
            sort[0]?.column === "market" &&
            sort[0].direction === "desc" &&
            sort[0].nulls === "last"
          );
        },
        10_000,
        "the daily preview sort to update the visible dataframe"
      );
      await target.frame
        .locator('td[data-grid-row="0"][data-grid-column="1"]')
        .filter({ hasText: "UK & Ireland" })
        .waitFor({ state: "visible", timeout: 10_000 });
      assertExactBytes(
        await vscode.workspace.fs.readFile(fixture),
        sourceBytes,
        "The daily preview sort must leave the CSV unchanged."
      );

      recordAcceptanceProgress("platform-smoke:daily-core:pandas-index");
      const notebook = await vscode.workspace.openNotebookDocument(notebookUri);
      const notebookEditor = await vscode.window.showNotebookDocument(notebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      notebookEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
      const rendererButton = await waitForNotebookRendererButton(page, notebookLabel, "Open in Open Wrangler");
      try {
        const renderedIndex = await rendererButton.evaluate((elementValue) => {
          type PreviewCell = { textContent: string | null };
          type PreviewRoot = { querySelectorAll(selector: string): ArrayLike<PreviewCell> };
          const preview = (elementValue as { closest(selector: string): PreviewRoot | null }).closest(
            "section.openwrangler-notebook"
          );
          if (!preview) return undefined;
          return {
            headers: Array.from(preview.querySelectorAll("thead th"), (cell) => cell.textContent),
            rowHeaders: Array.from(preview.querySelectorAll('tbody th[scope="row"]'), (cell) => cell.textContent),
            cells: Array.from(preview.querySelectorAll("tbody td"), (cell) => cell.textContent)
          };
        });
        assert.deepEqual(renderedIndex, {
          headers: ["sample_id", "value"],
          rowHeaders: ["SP0230700005-1"],
          cells: ["1"]
        });
      } finally {
        await rendererButton.dispose();
      }
    } catch (error) {
      failures.push(error);
    } finally {
      if (editorMayBeOpen) {
        try {
          recordAcceptanceProgress("platform-smoke:daily-core:cleanup");
          await withBoundedAcceptancePromise(
            vscode.commands.executeCommand("workbench.action.closeAllEditors"),
            10_000,
            "the daily preview editors to close"
          );
          await waitFor(
            () =>
              !notebookTab(notebookUri) &&
              !vscode.window.visibleNotebookEditors.some(
                (editor) => editor.notebook.uri.toString() === notebookUri.toString()
              ),
            10_000,
            "the daily preview notebook tab and editor to close"
          );
          editorMayBeOpen = false;
          await waitFor(
            () => testing.diagnostics().sessionCount === 0 && !testing.runtimeRunning(),
            10_000,
            "the daily preview session and runtime to terminate"
          );
          assert.deepEqual(testing.diagnostics().sessions, []);
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        assertExactBytes(
          await vscode.workspace.fs.readFile(fixture),
          sourceBytes,
          "Daily preview cleanup must preserve the CSV."
        );
      } catch (error) {
        failures.push(error);
      }
      if (!editorMayBeOpen) {
        try {
          cleanupAcceptanceTemporaryDirectory(notebookDirectory);
        } catch (error) {
          failures.push(error);
        }
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "The daily preview journey had multiple failures.");
  };
}
