import * as assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { OpenWranglerResponse } from "../../shared/protocol";
import { assertExactBytes } from "./acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./acceptanceTemporaryDirectory";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import {
  releasedRDocumentCleanedCsv,
  writeReleasedRDocumentFixture,
  writeReleasedRFileFixtures,
  type ReleasedRDocumentFixture
} from "./releasedDocumentFixtures";
import { assertReleasedRGeneratedCode } from "./releasedRGeneratedCode";
import { persistedReplayExportRequest } from "./persistedReplayExport";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRDocumentActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type ReleasedRDocumentPage = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedRDocumentJourneyDependencies {
  readonly acceptQuickPickOptionWithKeyboard: (
    page: Page,
    picker: Locator,
    title: string,
    option: string
  ) => Promise<void>;
  readonly acceptSearchableExcelSheet: (
    page: Page,
    testing: TestApi,
    source: vscode.Uri,
    sessionId: string,
    sheetName: string
  ) => Promise<void>;
  readonly waitForImportQuickInput: (
    page: Page,
    testing: TestApi,
    source: vscode.Uri,
    title: string,
    sessionId?: string
  ) => Promise<Locator>;
  readonly openReleasedROperationPicker: (
    testing: TestApi,
    page: Page,
    sessionId: string
  ) => Promise<{ app: Locator; dialog: Locator }>;
  readonly executeReleasedNotebookCell: (
    notebook: vscode.NotebookDocument,
    index: number,
    output: string,
    checkpoint: string,
    editor?: vscode.NotebookEditor
  ) => Promise<void>;
  readonly releasedNotebookJsonResult: (
    cell: vscode.NotebookCell,
    marker: string,
    description: string
  ) => Record<string, unknown>;
  readonly RELEASED_R_SUPPORTED_OPERATIONS: readonly string[];
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly acceptanceProcessIsAlive: (processId: number) => boolean;
  readonly assertParquetFile: (filePath: string, label: string) => void;
  readonly assertReleasedRDocumentFixtureUnchanged: (fixture: Pick<ReleasedRDocumentFixture, "immutableFiles">) => void;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRDocumentActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<ReleasedRDocumentPage>;
  readonly canonicalAcceptancePath: (candidate: string) => string;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly exerciseReleasedRDocumentGrid: (testing: TestApi, workbench: Page, sessionId: string) => Promise<void>;
  readonly invokeReleasedRDocumentVariable: (
    workbench: Page,
    source: vscode.Uri,
    variableName: string,
    assertDiscovery: boolean
  ) => Promise<void>;
  readonly previewReleasedRRename: (
    testing: TestApi,
    workbench: Page,
    app: Locator,
    sessionId: string,
    sourceName: string,
    newName: string,
    replacement?: Readonly<{ replaceStepId: string; previousName: string }>,
    variableName?: string
  ) => Promise<Readonly<{ app: Locator; stepId: string }>>;
  readonly readReleasedRDocumentProcessId: (processIdPath: string) => number;
  readonly recordAcceptanceProgress: (section: string) => void;
  readonly releasedRProcessRoots: () => string[];
  readonly releasedRSessionApp: (
    workbench: Page,
    testing: TestApi,
    sessionId: string,
    description: string
  ) => Promise<Locator>;
  readonly textDocumentTab: (uri: vscode.Uri) => vscode.Tab | undefined;
  readonly waitFor: (
    predicate: () => boolean,
    timeoutMs: number,
    expectation: string,
    diagnostics?: () => string
  ) => Promise<void>;
  readonly waitForReleasedRDocumentSession: (
    workbench: Page,
    testing: TestApi,
    document: vscode.TextDocument,
    variableName: string,
    description: string
  ) => Promise<ReleasedRDocumentActiveSession>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedRDocumentJourney({
  acceptQuickPickOptionWithKeyboard,
  acceptSearchableExcelSheet,
  waitForImportQuickInput,
  openReleasedROperationPicker,
  executeReleasedNotebookCell,
  releasedNotebookJsonResult,
  RELEASED_R_SUPPORTED_OPERATIONS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  acceptanceProcessIsAlive,
  assertParquetFile,
  assertReleasedRDocumentFixtureUnchanged,
  assertReleasedSessionPage,
  canonicalAcceptancePath,
  disposePackagedSessionPanel,
  exerciseReleasedRDocumentGrid,
  invokeReleasedRDocumentVariable,
  previewReleasedRRename,
  readReleasedRDocumentProcessId,
  recordAcceptanceProgress,
  releasedRProcessRoots,
  releasedRSessionApp,
  textDocumentTab,
  waitFor,
  waitForReleasedRDocumentSession,
  withBoundedAcceptancePromise
}: ReleasedRDocumentJourneyDependencies) {
  async function exerciseFileRecovery(
    testing: TestApi,
    workbench: Page,
    confirmed: ReleasedRDocumentActiveSession,
    fixture: ReleasedRDocumentFixture,
    initialRoots: readonly string[]
  ): Promise<void> {
    recordAcceptanceProgress("jupyter-r:file:recovery:stop");
    const runtimeId = testing
      .diagnostics()
      .sessions.find((session) => session.publicId === confirmed.sessionId)?.runtimeId;
    assert.ok(runtimeId);
    const oldRoots = releasedRProcessRoots().filter((root) => !initialRoots.includes(root));
    assert.equal(oldRoots.length, 1);
    const picker = await openReleasedROperationPicker(testing, workbench, confirmed.sessionId);
    await picker.dialog.getByRole("button", { name: /^Custom code\b/u }).click();
    await picker.dialog
      .getByLabel("Engine-native R", { exact: true })
      .fill(
        `base::writeLines(base::as.character(base::Sys.getpid()), ${JSON.stringify(fixture.processIdPath)})\nbase::quit(save = "no")`
      );
    await picker.dialog.getByRole("button", { name: "Preview changes", exact: true }).click();
    await picker.dialog.getByRole("alert").waitFor({ state: "visible", timeout: 30_000 });
    const processId = readReleasedRDocumentProcessId(fixture.processIdPath);
    await waitFor(() => !acceptanceProcessIsAlive(processId), 10_000, "the deliberately exited private file R process");
    await picker.dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await picker.dialog.waitFor({ state: "hidden", timeout: 10_000 });
    recordAcceptanceProgress("jupyter-r:file:recovery:reopen");
    // Public navigation requests an idempotent page; it must not repeat the failed Custom preview.
    const cell = picker.app.locator("td[data-grid-row][data-grid-column]").first();
    await cell.focus();
    await workbench.keyboard.press("Control+End");
    await waitFor(
      () => {
        const active = testing.activeSession();
        const current = testing.diagnostics().sessions.find((session) => session.publicId === confirmed.sessionId);
        return (
          active?.sessionId === confirmed.sessionId &&
          current !== undefined &&
          current.runtimeId !== runtimeId &&
          isDeepStrictEqual(active.metadata.steps, confirmed.metadata.steps) &&
          active.metadata.draftStep === undefined
        );
      },
      30_000,
      "the exact confirmed R file plan and public page to use a fresh runtime"
    );
    const recovered = testing.activeSession();
    assert.ok(recovered);
    assert.deepEqual(recovered.metadata.source, confirmed.metadata.source);
    assert.deepEqual(recovered.metadata.schema, confirmed.metadata.schema);
    assert.equal(recovered.code, confirmed.code);
    const app = await releasedRSessionApp(workbench, testing, confirmed.sessionId, "the recovered file renderer");
    await app.locator('td[data-grid-row="239"][data-grid-column="3"]').waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(
      await app.locator('td[data-grid-row="239"][data-grid-column="3"] .gridCellText').textContent(),
      "order-240"
    );
    await waitFor(
      () => oldRoots.every((root) => !existsSync(root)),
      10_000,
      "the retired R process root to be removed after recovery"
    );
    assert.equal(releasedRProcessRoots().filter((root) => !initialRoots.includes(root)).length, 1);
    assertReleasedRDocumentFixtureUnchanged(fixture);
    recordAcceptanceProgress("jupyter-r:file:recovery:complete");
  }

  async function exerciseWindowsFileInputs(
    testing: TestApi,
    workbench: Page,
    directory: string,
    notebook: vscode.NotebookDocument,
    notebookProcessId: number,
    initialRoots: readonly string[]
  ): Promise<void> {
    assert.equal(testing.diagnostics().sessionCount, 0);
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace);
    const inputs = writeReleasedRFileFixtures(
      path.join(directory, "file-inputs"),
      path.join(workspace.uri.fsPath, "fixtures")
    );
    const source = (name: string): vscode.Uri => {
      const input = inputs.find((file) => path.basename(file.path) === name);
      assert.ok(input);
      return vscode.Uri.file(input.path);
    };
    const ownedSessions = new Set<string>();
    const ownedTabs = new Set<vscode.Tab>();
    const retainTab = (): void => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      assert.ok(tab);
      ownedTabs.add(tab);
    };
    const preserve = (): void => assertReleasedRDocumentFixtureUnchanged({ immutableFiles: inputs });
    async function closeSessions(): Promise<void> {
      for (const id of [...ownedSessions]) {
        await disposePackagedSessionPanel(testing, id, "the qualified R file session");
        ownedSessions.delete(id);
      }
      await waitFor(
        () => isDeepStrictEqual(releasedRProcessRoots(), initialRoots),
        10_000,
        "all qualified R file private roots to close"
      );
      assert.equal(testing.diagnostics().sessionCount, 0);
      preserve();
    }
    async function open(uri: vscode.Uri, restore = false): Promise<ReleasedRDocumentActiveSession> {
      await withBoundedAcceptancePromise(
        restore
          ? vscode.commands.executeCommand("vscode.openWith", uri, "openWrangler.viewer", vscode.ViewColumn.One)
          : vscode.commands.executeCommand("openWrangler.openFile", uri),
        WORKBENCH_OPERATION_TIMEOUT_MS,
        restore
          ? "restoring the exact R input through its custom editor"
          : "opening the exact R input through its public command"
      );
      retainTab();
      await waitFor(
        () => testing.activeSession()?.metadata.source.uri === uri.toString(),
        30_000,
        "the exact R file source to publish"
      );
      const active = testing.activeSession();
      assert.ok(active);
      ownedSessions.add(active.sessionId);
      assert.equal(active.metadata.backend, "r");
      assert.equal(active.metadata.source.path, uri.fsPath);
      assert.equal(active.metadata.source.kind, "file");
      assert.equal(active.metadata.rDataframeFlavor, "r.data.frame");
      assert.equal(active.metadata.capabilities.notebookInsert, false);
      assert.notEqual(active.metadata.capabilities.documentInsert, true);
      return active;
    }
    async function checkCells(
      active: ReleasedRDocumentActiveSession,
      names: readonly string[],
      rows: readonly (readonly string[])[]
    ): Promise<Locator> {
      assert.deepEqual(
        active.metadata.schema.map((column) => column.name),
        names
      );
      assert.deepEqual(active.metadata.shape, { rows: rows.length, columns: names.length });
      const page = await assertReleasedSessionPage(testing, active, rows[0]![0]!, "jupyter-r-file-input-page");
      assert.deepEqual(
        page.page.rows.map((row) => row.values.map((cell) => cell.display)),
        rows
      );
      const app = await releasedRSessionApp(workbench, testing, active.sessionId, "the exact native file grid");
      assert.equal(await app.locator('[data-session-badge="backend"]').innerText(), "R");
      for (let column = 0; column < Math.min(2, names.length); column += 1) {
        const cell = app.locator(`td[data-grid-row="0"][data-grid-column="${column}"] .gridCellText`);
        await cell.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await cell.textContent(), rows[0]![column]);
      }
      preserve();
      return app;
    }
    try {
      recordAcceptanceProgress("jupyter-r:file:options:open");
      const csvUri = source("options.csv");
      const detected = await open(csvUri);
      assert.equal(detected.metadata.source.importOptions?.encoding, "windows-1252");
      const detectedApp = await releasedRSessionApp(
        workbench,
        testing,
        detected.sessionId,
        "the detected CP1252 source"
      );
      await detectedApp.getByRole("button", { name: "Import options", exact: true }).click();
      recordAcceptanceProgress("jupyter-r:file:options:configure");
      for (const [title, choice] of [
        ["Delimiter", "Semicolon"],
        ["Text encoding", "windows-1252"],
        ["Header row", "Generate column names"]
      ] as const) {
        const prompt = await waitForImportQuickInput(workbench, testing, csvUri, title, detected.sessionId);
        await acceptQuickPickOptionWithKeyboard(workbench, prompt, title, choice);
      }
      const quote = await waitForImportQuickInput(workbench, testing, csvUri, "Quote character", detected.sessionId);
      await quote.locator(".quick-input-box input").fill("'");
      await quote.locator(".quick-input-box input").press("Enter");
      const lineEnding = await waitForImportQuickInput(workbench, testing, csvUri, "Line ending", detected.sessionId);
      await acceptQuickPickOptionWithKeyboard(workbench, lineEnding, "Line ending", "CR");
      await waitFor(
        () =>
          testing.activeSession()?.metadata.source.uri === csvUri.toString() &&
          testing.activeSession()?.sessionId !== detected.sessionId,
        30_000,
        "the publicly selected native R CSV options"
      );
      retainTab();
      const configured = testing.activeSession();
      assert.ok(configured);
      ownedSessions.add(configured.sessionId);
      assert.equal(configured.metadata.backend, "r");
      assert.deepEqual(configured.metadata.source.importOptions, {
        delimiter: ";",
        encoding: "windows-1252",
        hasHeader: false,
        quoteChar: "'",
        lineEnding: "cr"
      });
      const csvRows = [
        ["1", "  €  "],
        ["2", "two;parts"],
        ["3", "two\r\nlines"]
      ];
      recordAcceptanceProgress("jupyter-r:file:options:verify");
      let app = await checkCells(configured, ["V1", "V2"], csvRows);
      recordAcceptanceProgress("jupyter-r:file:options:rename");
      const preview = await previewReleasedRRename(testing, workbench, app, configured.sessionId, "V1", "record_id");
      await preview.app
        .getByRole("region", { name: "Draft review" })
        .getByRole("button", { name: "Apply step", exact: true })
        .click();
      await waitFor(
        () =>
          testing.activeSession()?.sessionId === configured.sessionId &&
          testing.activeSession()?.metadata.steps[0]?.id === preview.stepId &&
          testing.activeSession()?.metadata.draftStep === undefined,
        30_000,
        "the configured CSV Rename to commit"
      );
      const applied = testing.activeSession();
      assert.ok(applied);
      const generatedCode = applied.code;
      assert.ok(generatedCode);
      recordAcceptanceProgress("jupyter-r:file:options:close");
      await closeSessions();
      recordAcceptanceProgress("jupyter-r:file:options:restore");
      const reopened = await open(csvUri, true);
      assert.notEqual(reopened.sessionId, applied.sessionId);
      assert.deepEqual(reopened.metadata.source, applied.metadata.source);
      assert.deepEqual(reopened.metadata.steps, applied.metadata.steps);
      assert.equal(reopened.code, generatedCode);
      await checkCells(reopened, ["record_id", "V2"], csvRows);
      await closeSessions();

      const cellIndex = notebook.cellCount;
      const marker = "__OW_RELEASED_R_FILE_GENERATED__";
      const code = `local({\n e <- base::new.env(parent = base::baseenv())\n base::eval(base::parse(text = ${JSON.stringify(generatedCode)}), envir = e)\n base::stopifnot(base::identical(e$open_wrangler_result, base::data.frame(record_id = 1:3, V2 = c("  €  ", "two;parts", "two\\r\\nlines"))))\n base::cat(${JSON.stringify(marker)}, jsonlite::toJSON(list(ok = TRUE, pid = base::Sys.getpid()), auto_unbox = TRUE), "\\n", sep = "")\n})`;
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, [
        vscode.NotebookEdit.insertCells(cellIndex, [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, "r")
        ])
      ]);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      try {
        const editor = await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.One });
        await executeReleasedNotebookCell(notebook, cellIndex, marker, "jupyter-r:file:generated", editor);
        const result = releasedNotebookJsonResult(notebook.cellAt(cellIndex), marker, "generated native file code");
        assert.equal(result.ok, true);
        assert.equal(
          result.pid,
          notebookProcessId,
          "Private file recovery must preserve the original notebook kernel."
        );
        assert.deepEqual(releasedRProcessRoots(), initialRoots);
        preserve();
      } finally {
        assert.equal(
          notebook.cellAt(cellIndex).document.getText(),
          code,
          "Only the owned generated-code cell may be removed."
        );
        const remove = new vscode.WorkspaceEdit();
        remove.set(notebook.uri, [vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cellIndex, cellIndex + 1))]);
        assert.equal(await vscode.workspace.applyEdit(remove), true);
      }

      for (const scenario of [
        {
          name: "source.ndjson",
          columns: ["id", "text", "flag", "amount"],
          rows: [
            ["1", "  é  ", "TRUE", "1.5"],
            ["2", "", "FALSE", "NA"],
            ["3", "NA", "NA", "2.5"]
          ]
        },
        { name: "legacy.xls", columns: ["name", "value", "active"], rows: [["first", "1", "TRUE"]] }
      ]) {
        const active = await open(source(scenario.name));
        await checkCells(active, scenario.columns, scenario.rows);
        await closeSessions();
      }
      const parquet = await open(source("r-file-input.parquet"));
      assert.deepEqual(
        parquet.metadata.schema.map((column) => column.name),
        ["id", "text", "flag", "amount", "at", "date", "unsigned32", "unsigned64"]
      );
      assert.deepEqual(parquet.metadata.shape, { rows: 3, columns: 8 });
      const parquetPage = await assertReleasedSessionPage(testing, parquet, "1", "jupyter-r-file-parquet");
      assert.deepEqual(
        parquetPage.page.rows.map((row) => row.values.slice(0, 4).map((cell) => cell.display)),
        [
          ["1", "  é  ", "TRUE", "2.5"],
          ["NA", "", "FALSE", "NaN"],
          ["9007199254740991", "NA", "NA", "NA"]
        ]
      );
      assert.deepEqual(
        parquetPage.page.rows.slice(0, 2).map((row) => row.values[7]?.display),
        ["0", "9223372036854775807"]
      );
      app = await releasedRSessionApp(workbench, testing, parquet.sessionId, "the native Parquet grid");
      assert.equal(
        await app.locator('td[data-grid-row="0"][data-grid-column="1"] .gridCellText').textContent(),
        "  é  "
      );
      await closeSessions();

      const excelUri = source("r-file-input.xlsx");
      const excel = await open(excelUri);
      assert.deepEqual(
        excel.metadata.schema.map((column) => column.name),
        ["id", "text", "flag", "amount", "at", "same", "same", ""]
      );
      assert.deepEqual(excel.metadata.shape, { rows: 3, columns: 8 });
      const excelPage = await assertReleasedSessionPage(testing, excel, "1", "jupyter-r-file-excel");
      assert.deepEqual(
        excelPage.page.rows.map((row) => row.values.slice(0, 4).map((cell) => cell.display)),
        [
          ["1", "  é  ", "TRUE", "2.5"],
          ["2", "NA", "FALSE", "NA"],
          ["3", "NA", "NA", "-0.5"]
        ]
      );
      assert.equal(excelPage.page.rows[1]?.values[1]?.kind, "string");
      assert.equal(excelPage.page.rows[2]?.values[1]?.kind, "null");
      app = await releasedRSessionApp(
        workbench,
        testing,
        excel.sessionId,
        "the native Excel grid before its actual sheet picker"
      );
      await app.getByRole("button", { name: "Import options", exact: true }).click();
      await acceptSearchableExcelSheet(workbench, testing, excelUri, excel.sessionId, "cached");
      await waitFor(
        () =>
          testing.activeSession()?.sessionId !== excel.sessionId &&
          testing.activeSession()?.metadata.source.importOptions?.sheetName === "cached",
        30_000,
        "the selected nonfirst worksheet to own a separate native R session"
      );
      retainTab();
      const selected = testing.activeSession();
      assert.ok(selected);
      ownedSessions.add(selected.sessionId);
      assert.equal(selected.metadata.backend, "r");
      assert.equal(selected.metadata.source.uri, excelUri.toString());
      assert.equal(selected.metadata.source.path, excelUri.fsPath);
      assert.deepEqual(selected.metadata.source.importOptions, { sheetName: "cached" });
      assert.deepEqual(testing.sessionSnapshot(excel.sessionId)?.metadata.source, excel.metadata.source);
      assert.deepEqual(testing.sessionSnapshot(excel.sessionId)?.metadata.schema, excel.metadata.schema);
      app = await checkCells(
        selected,
        ["true_zero", "cached_zero", "cached_three", "uncached", "error", "whitespace"],
        [["0", "0", "3", "NA", "NA", "NA"]]
      );
      const cachedThree = app.locator('td[data-grid-row="0"][data-grid-column="2"] .gridCellText');
      await cachedThree.waitFor({ state: "visible", timeout: 10_000 });
      assert.equal(await cachedThree.textContent(), "3");
      const search = app.getByRole("combobox", { name: "Column", exact: true });
      await search.fill("whitespace");
      await app.getByRole("option", { name: /^whitespace,/u }).waitFor({ state: "visible", timeout: 10_000 });
      await search.press("Enter");
      for (const column of [3, 4, 5]) {
        const cell = app.locator(`td[data-grid-row="0"][data-grid-column="${column}"]`);
        await cell.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await cell.getAttribute("aria-label"), "Null value");
      }
      await closeSessions();
    } finally {
      await closeSessions();
      const remainingTabs = vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => ownedTabs.has(tab));
      if (remainingTabs.length) assert.equal(await vscode.window.tabGroups.close(remainingTabs, true), true);
      preserve();
    }
  }

  return async function exerciseReleasedRDocumentJourney(
    testing: TestApi,
    workbench: Page,
    directory: string,
    entry: "document" | "document-and-file" | "file" = "document",
    notebook?: Readonly<{ document: vscode.NotebookDocument; processId: number }>
  ): Promise<void> {
    recordAcceptanceProgress("jupyter-r:document:create");
    assert.equal(vscode.workspace.isTrusted, true, "Running a plain R file requires the trusted packaged workspace.");
    assert.equal(testing.diagnostics().sessionCount, 0, "The plain R journey must start without another session.");
    const fixture = writeReleasedRDocumentFixture(directory);
    const configuration = vscode.workspace.getConfiguration("openWrangler", fixture.sourceUri);
    const filesConfiguration = vscode.workspace.getConfiguration("files", fixture.sourceUri);
    const originalRscriptPath = configuration.inspect<string>("rscriptPath")?.workspaceValue;
    const autoSaveInspection = filesConfiguration.inspect<string>("autoSave");
    const originalAutoSave = autoSaveInspection?.workspaceValue;
    const resolvedAutoSave = filesConfiguration.get<string>("autoSave", "off");
    const exactRscript = process.env.OPEN_WRANGLER_TEST_RSCRIPT;
    const initialProcessRoots = releasedRProcessRoots();
    assert.ok(
      exactRscript && path.isAbsolute(exactRscript) && !/[\0\r\n]/u.test(exactRscript),
      "The packaged plain R journey requires the runner-owned exact Rscript path."
    );
    assert.equal(
      configuration.inspect<"viewing" | "editing">("fileStartMode")?.defaultValue,
      "editing",
      "Plain R files must use the normal editable file-session default."
    );

    let sourceDocument: vscode.TextDocument | undefined;
    let decoyDocument: vscode.TextDocument | undefined;
    try {
      await configuration.update("rscriptPath", exactRscript, vscode.ConfigurationTarget.Workspace);
      if (entry !== "file") {
        recordAcceptanceProgress(
          [
            "jupyter-r:document:auto-save",
            `default=${autoSaveInspection?.defaultValue ?? "unset"}`,
            `global=${autoSaveInspection?.globalValue ?? "unset"}`,
            `workspace=${autoSaveInspection?.workspaceValue ?? "unset"}`,
            `resolved=${resolvedAutoSave}`
          ].join(":")
        );
        if (resolvedAutoSave !== "off") {
          await filesConfiguration.update("autoSave", "off", vscode.ConfigurationTarget.Workspace);
        }
        sourceDocument = await vscode.workspace.openTextDocument(fixture.sourceUri);
        const sourceTextBefore = sourceDocument.getText();
        const sourceVersionBefore = sourceDocument.version;
        await vscode.window.showTextDocument(sourceDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
        assert.equal(vscode.window.activeTextEditor?.document, sourceDocument);

        recordAcceptanceProgress("jupyter-r:document:first-run");
        await invokeReleasedRDocumentVariable(workbench, fixture.sourceUri, "orders_frame", true);
        const opened = await waitForReleasedRDocumentSession(
          workbench,
          testing,
          sourceDocument,
          "orders_frame",
          "the data.frame opened from a real R source file"
        );
        assert.deepEqual(opened.metadata.shape, { rows: 240, columns: 4 });
        assert.deepEqual(
          opened.metadata.schema.map((column) => column.name),
          ["row_id", "group", "score", "label"]
        );
        assert.deepEqual(opened.metadata.capabilities, {
          editable: true,
          lazy: false,
          cancel: false,
          exportCsv: true,
          exportParquet: true,
          filter: true,
          sort: true,
          profile: true,
          columnValues: true,
          supportedOperations: RELEASED_R_SUPPORTED_OPERATIONS,
          notebookInsert: false,
          documentInsert: true
        });
        const firstProcessId = readReleasedRDocumentProcessId(fixture.processIdPath);
        assert.equal(
          acceptanceProcessIsAlive(firstProcessId),
          true,
          "The exact R source process must own the open session."
        );
        const processRoots = releasedRProcessRoots().filter((root) => !initialProcessRoots.includes(root));
        assert.equal(processRoots.length, 1, "The plain R session must own one private process root.");
        const processRoot = processRoots[0]!;

        await exerciseReleasedRDocumentGrid(testing, workbench, opened.sessionId);
        let app = await releasedRSessionApp(workbench, testing, opened.sessionId, "the editable plain R session");
        const previewed = await previewReleasedRRename(
          testing,
          workbench,
          app,
          opened.sessionId,
          "row_id",
          "record_id",
          undefined,
          "orders_frame"
        );
        app = previewed.app;
        await app
          .getByRole("region", { name: "Draft review" })
          .getByRole("button", { name: "Apply step", exact: true })
          .click();
        await waitFor(
          () => {
            const active = testing.activeSession();
            const step = active?.metadata.steps[0];
            return (
              active?.sessionId === opened.sessionId &&
              active.metadata.draftStep === undefined &&
              active.metadata.steps.length === 1 &&
              step?.kind === "renameColumn" &&
              step.id === previewed.stepId &&
              step.params.column.name === "row_id" &&
              step.params.newName === "record_id" &&
              active.metadata.schema[0]?.name === "record_id"
            );
          },
          30_000,
          "applying the plain R rename"
        );
        app = await releasedRSessionApp(
          workbench,
          testing,
          opened.sessionId,
          "the applied plain R session before export"
        );
        const applied = testing.activeSession();
        assert.ok(applied, "The applied plain R rename must retain its session.");
        const generatedCode = applied.code ?? "";
        assertReleasedRGeneratedCode(generatedCode, "record_id", "orders_frame");
        assert.equal(applied.metadata.capabilities.documentInsert, true);
        assert.equal(applied.metadata.capabilities.notebookInsert, false);
        assert.equal(applied.metadata.capabilities.exportCsv, true);
        assert.equal(applied.metadata.capabilities.exportParquet, true);

        recordAcceptanceProgress("jupyter-r:document:export-cleaned-csv");
        await app.getByRole("button", { name: "Export", exact: true }).waitFor({ state: "visible", timeout: 10_000 });
        const exportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-r-document-export-"));
        const exportPath = path.join(exportDirectory, "orders-cleaned.csv");
        const parquetExportPath = path.join(exportDirectory, "orders-cleaned.parquet");
        try {
          await exportCleanedDataThroughWorkbench(app, workbench, exportPath);
          await waitFor(() => existsSync(exportPath), 30_000, "the cleaned R CSV export to appear");
          assertExactBytes(
            readFileSync(exportPath),
            releasedRDocumentCleanedCsv(),
            "The public R export command must write every cleaned row and the renamed schema."
          );
          app = await releasedRSessionApp(
            workbench,
            testing,
            opened.sessionId,
            "the applied plain R session after CSV export"
          );
          await exportCleanedDataThroughWorkbench(app, workbench, parquetExportPath, "parquet");
          await waitFor(() => existsSync(parquetExportPath), 30_000, "the cleaned R Parquet export to appear");
          assertParquetFile(parquetExportPath, "The public R document export");
          assert.deepEqual(
            readdirSync(exportDirectory).sort(),
            [path.basename(exportPath), path.basename(parquetExportPath)].sort(),
            "R document exports must not retain sibling temporary files."
          );
          const privateExportRoot = path.join(processRoot, "exports");
          const cleanedExports = readdirSync(privateExportRoot, { withFileTypes: true });
          assert.equal(cleanedExports.length, 2, "Each R export must leave only its scrubbed private artifact.");
          for (const entry of cleanedExports) {
            assert.match(entry.name, /^\.openwrangler-cleanup-[A-Za-z0-9]+$/u);
            assert.equal(entry.isDirectory(), true, "Private export cleanup must use an owned directory.");
            const cleanupDirectory = path.join(privateExportRoot, entry.name);
            assert.deepEqual(readdirSync(cleanupDirectory), ["artifact"]);
            const artifactPath = path.join(cleanupDirectory, "artifact");
            const artifact = lstatSync(artifactPath);
            assert.equal(artifact.isFile(), true, "The scrubbed export artifact must be a regular file.");
            assert.equal(artifact.nlink, 1, "The scrubbed export artifact must not have another link.");
            assert.equal(artifact.size, 0, "Private R export bytes must be scrubbed.");
          }
          assert.equal(sourceDocument.getText(), sourceTextBefore, "Export must not edit the open R source document.");
          assert.equal(
            sourceDocument.version,
            sourceVersionBefore,
            "Export must not change the R source document version."
          );
          assert.equal(sourceDocument.isDirty, false, "Export must leave the R source document clean.");
          assertReleasedRDocumentFixtureUnchanged(fixture);
        } finally {
          cleanupAcceptanceTemporaryDirectory(exportDirectory);
        }

        recordAcceptanceProgress("jupyter-r:document:insert-with-decoy-active");
        const insertionSourceDocument = sourceDocument;
        const insertionSourceVersion = insertionSourceDocument.version;
        const insertionSourceText = insertionSourceDocument.getText();
        recordAcceptanceProgress("jupyter-r:document:insert:open-decoy");
        decoyDocument = await vscode.workspace.openTextDocument(fixture.decoyUri);
        recordAcceptanceProgress("jupyter-r:document:insert:decoy-opened");
        const decoyTextBefore = decoyDocument.getText();
        await vscode.window.showTextDocument(decoyDocument, { preview: false, viewColumn: vscode.ViewColumn.Beside });
        recordAcceptanceProgress("jupyter-r:document:insert:decoy-shown");
        assert.equal(
          vscode.window.activeTextEditor?.document,
          decoyDocument,
          "The insertion journey must keep an unrelated R document active."
        );
        assert.equal(insertionSourceDocument.version, insertionSourceVersion);
        assert.equal(insertionSourceDocument.getText(), insertionSourceText);
        testing.setActiveSession(opened.sessionId);
        recordAcceptanceProgress("jupyter-r:document:insert:session-active");
        const insertionSession = testing.activeSession();
        assert.equal(insertionSession?.sessionId, opened.sessionId);
        assert.equal(insertionSession.metadata.capabilities.documentInsert, true);
        assert.equal(insertionSession.metadata.capabilities.notebookInsert, false);
        const insertion = vscode.commands.executeCommand<boolean>("openWrangler.insertRDocumentCode");
        recordAcceptanceProgress("jupyter-r:document:insert:dispatched");
        const pendingInsertionReceipt = setTimeout(() => {
          recordAcceptanceProgress(
            [
              "jupyter-r:document:insert:pending",
              `status=${testing.notebookInsertionStatus() ?? "unset"}`,
              `versionDelta=${insertionSourceDocument.version - insertionSourceVersion}`,
              `textChanged=${insertionSourceDocument.getText() !== insertionSourceText}`,
              `documentInsert=${testing.activeSession()?.metadata.capabilities.documentInsert === true}`
            ].join(":")
          );
        }, 5_000);
        let inserted: boolean | undefined;
        try {
          inserted = await withBoundedAcceptancePromise(insertion, 30_000, "plain R generated-code insertion");
        } finally {
          clearTimeout(pendingInsertionReceipt);
        }
        recordAcceptanceProgress(
          [
            "jupyter-r:document:insert:completed",
            `status=${testing.notebookInsertionStatus() ?? "unset"}`,
            `versionDelta=${insertionSourceDocument.version - insertionSourceVersion}`,
            `textChanged=${insertionSourceDocument.getText() !== insertionSourceText}`
          ].join(":")
        );
        assert.equal(inserted, true, "Generated R must insert into its exact source document.");
        assert.equal(testing.notebookInsertionStatus(), "applied");
        recordAcceptanceProgress("jupyter-r:document:insert:verify-active-decoy");
        assert.equal(vscode.window.activeTextEditor?.document, decoyDocument);
        assert.equal(decoyDocument.getText(), decoyTextBefore, "The active decoy R file must not change.");
        assert.equal(decoyDocument.isDirty, false, "The active decoy R file must remain clean.");
        recordAcceptanceProgress("jupyter-r:document:insert:verify-disk-unchanged");
        assertReleasedRDocumentFixtureUnchanged(fixture);
        recordAcceptanceProgress("jupyter-r:document:insert:verify-source-edit");
        await waitFor(
          () => {
            assertReleasedRDocumentFixtureUnchanged(fixture);
            return sourceDocument?.isDirty === true;
          },
          5_000,
          "the generated R source edit to become dirty"
        );
        assert.equal(sourceDocument.isDirty, true, "Generated R insertion must remain an unsaved source edit.");
        assert.ok(sourceDocument.version > sourceVersionBefore);
        assert.ok(
          sourceDocument.getText().includes(generatedCode.trimEnd()),
          "The exact in-memory source must contain the generated cleaning code."
        );
        assert.equal(
          sourceDocument.getText().split(generatedCode.trimEnd()).length - 1,
          1,
          "Generated R must be inserted exactly once."
        );
        assert.equal(sourceDocument.getText().startsWith(sourceTextBefore), true);
        assertReleasedRDocumentFixtureUnchanged(fixture);

        recordAcceptanceProgress("jupyter-r:document:undo-from-retained-panel");
        await app.getByRole("button", { name: "Undo", exact: true }).click();
        await waitFor(
          () => {
            const active = testing.activeSession();
            return (
              active?.sessionId === opened.sessionId &&
              active.metadata.steps.length === 0 &&
              active.metadata.draftStep === undefined &&
              active.metadata.schema[0]?.name === "row_id" &&
              (active.code ?? "") === ""
            );
          },
          30_000,
          "undoing the plain R rename"
        );
        assert.ok(
          sourceDocument.getText().includes(generatedCode.trimEnd()),
          "Undoing the session plan must not rewrite the user's unsaved R document."
        );

        recordAcceptanceProgress("jupyter-r:document:first-close");
        await disposePackagedSessionPanel(testing, opened.sessionId, "the first plain R session");
        await waitFor(
          () => !acceptanceProcessIsAlive(firstProcessId),
          10_000,
          "the first private plain R process to stop"
        );
        await waitFor(
          () => isDeepStrictEqual(releasedRProcessRoots(), initialProcessRoots),
          10_000,
          "the first private plain R process root to be removed"
        );
        assert.equal(testing.diagnostics().sessionCount, 0);

        recordAcceptanceProgress("jupyter-r:document:rerun-unsaved-source");
        await vscode.window.showTextDocument(sourceDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
        assert.equal(vscode.window.activeTextEditor?.document, sourceDocument);
        await invokeReleasedRDocumentVariable(workbench, fixture.sourceUri, "open_wrangler_result", false);
        const rerun = await waitForReleasedRDocumentSession(
          workbench,
          testing,
          sourceDocument,
          "open_wrangler_result",
          "the generated result opened after rerunning the unsaved R source"
        );
        assert.equal(rerun.metadata.schema[0]?.name, "record_id");
        assert.deepEqual(rerun.metadata.shape, { rows: 240, columns: 4 });
        const rerunPage = await assertReleasedSessionPage(testing, rerun, "1", "jupyter-r-document-rerun-page");
        assert.equal(rerunPage.metadata.schema[0]?.name, "record_id");
        const secondProcessId = readReleasedRDocumentProcessId(fixture.processIdPath);
        assert.equal(acceptanceProcessIsAlive(secondProcessId), true);
        await disposePackagedSessionPanel(testing, rerun.sessionId, "the rerun plain R session");
        await waitFor(
          () => !acceptanceProcessIsAlive(secondProcessId),
          10_000,
          "the rerun private plain R process to stop"
        );
        assert.equal(testing.diagnostics().sessionCount, 0);
        assertReleasedRDocumentFixtureUnchanged(fixture);
        assert.equal(sourceDocument.isDirty, true, "The generated source edit must still be unsaved before cleanup.");
      }
      if (entry !== "document") {
        recordAcceptanceProgress("jupyter-r:file:start");
        const csvPath = path.join(path.dirname(fixture.sourceUri.fsPath), "orders.csv");
        const csvUri = vscode.Uri.file(csvPath);
        const csvConfiguration = vscode.workspace.getConfiguration("openWrangler", csvUri);
        const originalBackend = csvConfiguration.inspect<string>("defaultBackend")?.workspaceValue;
        let csvSessionId: string | undefined;
        await waitFor(
          () => isDeepStrictEqual(releasedRProcessRoots(), initialProcessRoots),
          10_000,
          "the managed process roots to settle before opening CSV"
        );
        const csvExportDirectory = mkdtempSync(path.join(tmpdir(), "openwrangler-file-export-"));
        try {
          await csvConfiguration.update("defaultBackend", "r", vscode.ConfigurationTarget.Workspace);
          await withBoundedAcceptancePromise(
            vscode.commands.executeCommand("openWrangler.openFile", csvUri),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "opening the existing CSV fixture through the public native R file command"
          );
          await waitFor(
            () => {
              const active = testing.activeSession();
              return active?.metadata.source.kind === "file" && active.metadata.source.uri === csvUri.toString();
            },
            30_000,
            "the source-bound native R CSV session"
          );
          const csv = testing.activeSession();
          assert.ok(csv);
          csvSessionId = csv.sessionId;
          assert.equal(csv.metadata.source.path, csvPath);
          assert.equal(csv.metadata.backend, "r");
          assert.equal(csv.metadata.rDataframeFlavor, "r.data.frame");
          assert.equal(csv.metadata.mode, "editing");
          assert.deepEqual(csv.metadata.shape, { rows: 240, columns: 4 });
          assert.deepEqual(
            csv.metadata.schema.map((column) => column.name),
            ["row_id", "group", "score", "label"]
          );
          assert.equal(
            csv.metadata.capabilities.documentInsert === true,
            false,
            "An R CSV session must not enable source-document insertion."
          );
          assert.equal(csv.metadata.capabilities.notebookInsert, false);
          assert.equal(releasedRProcessRoots().filter((root) => !initialProcessRoots.includes(root)).length, 1);
          const csvPage = await assertReleasedSessionPage(testing, csv, "1", "jupyter-r-file-page");
          assert.deepEqual(
            csvPage.page.rows.map((row) => row.values.map((cell) => ({ kind: cell.kind, raw: cell.raw }))),
            Array.from({ length: 10 }, (_, index) => {
              const row = index + 1;
              return [
                { kind: "integer", raw: String(row) },
                { kind: "string", raw: row % 2 === 0 ? "B" : "A" },
                { kind: "integer", raw: String(row) },
                { kind: "string", raw: `order-${String(row).padStart(3, "0")}` }
              ];
            })
          );
          let csvApp = await releasedRSessionApp(workbench, testing, csvSessionId, "the native R CSV renderer");
          assert.equal(
            await csvApp.getByRole("button", { name: "Header profiles", exact: true }).getAttribute("aria-pressed"),
            "true"
          );
          await csvApp
            .locator(
              'th[data-column="row_id"] .exactSummaryStats' +
                ':has([aria-label="Missing: 0 (0%)"])' +
                ':has([aria-label="Distinct: 240 (100%)"])' +
                ':has([aria-label="Minimum 1"])' +
                ':has([aria-label="Maximum 240"])'
            )
            .waitFor({ state: "visible", timeout: 10_000 });
          recordAcceptanceProgress("jupyter-r:file:rename");
          const renamed = await previewReleasedRRename(testing, workbench, csvApp, csvSessionId, "row_id", "record_id");
          csvApp = renamed.app;
          await csvApp
            .getByRole("region", { name: "Draft review" })
            .getByRole("button", { name: "Apply step", exact: true })
            .click();
          await waitFor(
            () => {
              const active = testing.activeSession();
              return (
                active?.sessionId === csv.sessionId &&
                active.metadata.draftStep === undefined &&
                active.metadata.steps.length === 1 &&
                active.metadata.steps[0]?.id === renamed.stepId &&
                active.metadata.schema[0]?.name === "record_id"
              );
            },
            30_000,
            "the committed native R CSV Rename"
          );
          const csvApplied = testing.activeSession();
          assert.ok(csvApplied);
          assertReleasedRGeneratedCode(csvApplied.code ?? "", "record_id", {
            path: csvPath,
            header: csvApplied.metadata.source.importOptions?.hasHeader ?? true,
            delimiter: csvApplied.metadata.source.importOptions?.delimiter ?? ",",
            encoding:
              csvApplied.metadata.source.importOptions?.encoding === "utf8"
                ? "utf-8"
                : (csvApplied.metadata.source.importOptions?.encoding ?? "utf-8"),
            quoteChar: csvApplied.metadata.source.importOptions?.quoteChar ?? '"'
          });
          if (entry === "file") {
            csvApp = await releasedRSessionApp(workbench, testing, csvSessionId, "the R CSV before Undo");
            await csvApp.getByRole("button", { name: "Undo", exact: true }).click();
            await waitFor(
              () => {
                const active = testing.activeSession();
                return (
                  active !== undefined &&
                  active.sessionId === csvSessionId &&
                  active.metadata.steps.length === 0 &&
                  active.metadata.schema[0]?.name === "row_id" &&
                  active.metadata.draftStep === undefined
                );
              },
              30_000,
              "R CSV Undo to restore the original schema"
            );
            csvApp = await releasedRSessionApp(workbench, testing, csvSessionId, "the R CSV before Redo");
            await csvApp.getByRole("button", { name: "Redo", exact: true }).click();
            await waitFor(
              () => {
                const active = testing.activeSession();
                return (
                  active !== undefined &&
                  active.sessionId === csvSessionId &&
                  active.metadata.steps[0]?.id === renamed.stepId &&
                  active.metadata.schema[0]?.name === "record_id" &&
                  active.metadata.draftStep === undefined
                );
              },
              30_000,
              "R CSV Redo to restore the exact committed Rename"
            );
            assert.equal(testing.activeSession()?.code, csvApplied.code);
          }
          const exportSession = testing.activeSession();
          assert.ok(exportSession);
          await assert.rejects(
            testing.request(
              persistedReplayExportRequest(
                { backend: "r", sessionId: csvSessionId, revision: exportSession.metadata.revision },
                csvPath,
                "csv"
              )
            ),
            /never overwrites the active source/u,
            "R file export must refuse the original CSV destination."
          );
          assertReleasedRDocumentFixtureUnchanged(fixture);
          recordAcceptanceProgress("jupyter-r:file:export");
          csvApp = await releasedRSessionApp(workbench, testing, csvSessionId, "the applied native R CSV session");
          const csvExportPath = path.join(csvExportDirectory, "orders-cleaned.csv");
          await exportCleanedDataThroughWorkbench(csvApp, workbench, csvExportPath);
          recordAcceptanceProgress("jupyter-r:file:export:verify");
          await waitFor(() => existsSync(csvExportPath), 30_000, "the cleaned R file CSV export");
          assertExactBytes(
            readFileSync(csvExportPath),
            releasedRDocumentCleanedCsv(),
            "R file export must retain all 240 cleaned rows."
          );
          assert.deepEqual(readdirSync(csvExportDirectory), ["orders-cleaned.csv"]);
          assertReleasedRDocumentFixtureUnchanged(fixture);
          if (entry === "file") {
            const confirmed = testing.activeSession();
            assert.ok(confirmed);
            await exerciseFileRecovery(testing, workbench, confirmed, fixture, initialProcessRoots);
            recordAcceptanceProgress("jupyter-r:file:recovery:close");
            await disposePackagedSessionPanel(testing, csvSessionId, "the recovered native R CSV");
            csvSessionId = undefined;
            await waitFor(
              () => isDeepStrictEqual(releasedRProcessRoots(), initialProcessRoots),
              10_000,
              "the recovered CSV owner to close"
            );
            assert.ok(notebook, "Windows file generated-code checks require the exact existing R notebook.");
            await exerciseWindowsFileInputs(
              testing,
              workbench,
              directory,
              notebook.document,
              notebook.processId,
              initialProcessRoots
            );
          }
        } finally {
          try {
            if (csvSessionId) await disposePackagedSessionPanel(testing, csvSessionId, "the native R CSV session");
            await waitFor(
              () => isDeepStrictEqual(releasedRProcessRoots(), initialProcessRoots),
              10_000,
              "the native R CSV private process root to be removed"
            );
            assert.equal(testing.diagnostics().sessionCount, 0);
          } finally {
            try {
              await csvConfiguration.update("defaultBackend", originalBackend, vscode.ConfigurationTarget.Workspace);
            } finally {
              cleanupAcceptanceTemporaryDirectory(csvExportDirectory);
            }
          }
        }
        recordAcceptanceProgress("jupyter-r:file:complete");
      }
    } finally {
      try {
        await configuration.update("rscriptPath", originalRscriptPath, vscode.ConfigurationTarget.Workspace);
      } finally {
        if (sourceDocument && !sourceDocument.isClosed && sourceDocument.isDirty) {
          recordAcceptanceProgress("jupyter-r:document:cleanup:revert-source");
          await vscode.window.showTextDocument(sourceDocument, { preview: false, viewColumn: vscode.ViewColumn.One });
          assert.equal(vscode.window.activeTextEditor?.document, sourceDocument);
          await withBoundedAcceptancePromise(
            vscode.commands.executeCommand("workbench.action.files.revert"),
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "reverting the synthetic R source without saving it"
          );
          await waitFor(
            () => !sourceDocument?.isDirty,
            WORKBENCH_OPERATION_TIMEOUT_MS,
            "the synthetic R source to become clean after revert"
          );
          const originalSource = fixture.immutableFiles.find(
            (file) => canonicalAcceptancePath(file.path) === canonicalAcceptancePath(fixture.sourceUri.fsPath)
          );
          assert.ok(originalSource, "The plain R fixture must retain its immutable source bytes.");
          assertExactBytes(
            Buffer.from(sourceDocument.getText(), "utf8"),
            originalSource.bytes,
            "Plain R cleanup must restore the in-memory source from its unchanged disk bytes."
          );
        }
        const tabs = [fixture.sourceUri, fixture.decoyUri]
          .map(textDocumentTab)
          .filter((tab): tab is vscode.Tab => tab !== undefined);
        if (tabs.length > 0) {
          assert.equal(
            await vscode.window.tabGroups.close(tabs, true),
            true,
            "Plain R cleanup must close its clean tabs."
          );
        }
        assertReleasedRDocumentFixtureUnchanged(fixture);
        if (entry !== "file" && resolvedAutoSave !== "off") {
          await filesConfiguration.update("autoSave", originalAutoSave, vscode.ConfigurationTarget.Workspace);
        }
      }
    }
  };
}
