import * as assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
  type ReleasedRDocumentFixture
} from "./releasedDocumentFixtures";
import { assertReleasedRGeneratedCode } from "./releasedRGeneratedCode";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRDocumentActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type ReleasedRDocumentPage = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedRDocumentJourneyDependencies {
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
  readonly requireFreshExactSessionPanelHydration: (
    testing: TestApi,
    sessionId: string,
    expectation: string
  ) => Promise<void>;
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
  requireFreshExactSessionPanelHydration,
  textDocumentTab,
  waitFor,
  waitForReleasedRDocumentSession,
  withBoundedAcceptancePromise
}: ReleasedRDocumentJourneyDependencies) {
  return async function exerciseReleasedRDocumentJourney(
    testing: TestApi,
    workbench: Page,
    directory: string
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
      await requireFreshExactSessionPanelHydration(
        testing,
        opened.sessionId,
        "The applied plain R rename must reach its exact renderer before insertion."
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
      app = await releasedRSessionApp(
        workbench,
        testing,
        opened.sessionId,
        "the applied plain R session before export"
      );
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
        assert.deepEqual(
          readdirSync(path.join(processRoot, "exports")),
          [],
          "The R process must remove its private export artifacts after the host has copied them."
        );
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
        if (resolvedAutoSave !== "off") {
          await filesConfiguration.update("autoSave", originalAutoSave, vscode.ConfigurationTarget.Workspace);
        }
      }
    }
  };
}
