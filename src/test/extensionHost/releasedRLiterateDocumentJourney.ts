import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { supportsRDocumentExecution } from "../../extension/r/rDocumentCommands";
import type { OpenWranglerResponse } from "../../shared/protocol";
import { withAcceptanceOperationDeadline } from "./playwrightLifecycle";
import {
  writeReleasedPythonQuartoDocumentFixture,
  writeReleasedRLiterateDocumentFixture,
  type ReleasedPythonQuartoDocumentFixture,
  type ReleasedRLiterateDocumentFixture
} from "./releasedDocumentFixtures";
import type { TestApi } from "./extensionHostTestApi";

type ReleasedRLiterateActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type ReleasedRLiteratePage = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedRLiterateDocumentJourneyDependencies {
  readonly OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS: number;
  readonly WORKBENCH_OPERATION_TIMEOUT_MS: number;
  readonly acceptanceProcessIsAlive: (processId: number) => boolean;
  readonly assertReleasedNativeREditorTooling: () => Promise<boolean>;
  readonly assertReleasedRDocumentFixtureUnchanged: (
    fixture: Pick<ReleasedRLiterateDocumentFixture, "immutableFiles">
  ) => void;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRLiterateActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<ReleasedRLiteratePage>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly exerciseReleasedPythonQuartoDocumentJourney: (
    testing: TestApi,
    workbench: Page,
    fixture: ReleasedPythonQuartoDocumentFixture
  ) => Promise<void>;
  readonly exerciseReleasedRDocumentJourney: (testing: TestApi, workbench: Page, directory: string) => Promise<void>;
  readonly invokeReleasedRDocumentTitleAction: (
    workbench: Page,
    source: vscode.Uri,
    variableName: string,
    screenshotOutput?: string
  ) => Promise<void>;
  readonly invokeReleasedRDocumentVariable: (
    workbench: Page,
    source: vscode.Uri,
    variableName: string,
    assertDiscovery: boolean
  ) => Promise<void>;
  readonly isReleasedOfficialRTerminal: (terminal: vscode.Terminal) => boolean;
  readonly openReleasedNativeQuartoPreview: (workbench: Page, source: vscode.Uri) => Promise<() => Promise<void>>;
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
  ) => Promise<ReleasedRLiterateActiveSession>;
  readonly withBoundedAcceptancePromise: <T>(
    promise: PromiseLike<T>,
    timeoutMs: number,
    description: string
  ) => Promise<T>;
}

export function createReleasedRLiterateDocumentJourneys({
  OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
  WORKBENCH_OPERATION_TIMEOUT_MS,
  acceptanceProcessIsAlive,
  assertReleasedNativeREditorTooling,
  assertReleasedRDocumentFixtureUnchanged,
  assertReleasedSessionPage,
  disposePackagedSessionPanel,
  exerciseReleasedPythonQuartoDocumentJourney,
  exerciseReleasedRDocumentJourney,
  invokeReleasedRDocumentTitleAction,
  invokeReleasedRDocumentVariable,
  isReleasedOfficialRTerminal,
  openReleasedNativeQuartoPreview,
  previewReleasedRRename,
  readReleasedRDocumentProcessId,
  recordAcceptanceProgress,
  releasedRSessionApp,
  requireFreshExactSessionPanelHydration,
  textDocumentTab,
  waitFor,
  waitForReleasedRDocumentSession,
  withBoundedAcceptancePromise
}: ReleasedRLiterateDocumentJourneyDependencies) {
  return async function exerciseReleasedRLiterateDocumentJourneys(
    testing: TestApi,
    workbench: Page,
    directory: string,
    screenshotOutput?: string
  ): Promise<void> {
    const nativeREditorTooling = await assertReleasedNativeREditorTooling();
    const fixtures = [
      writeReleasedRLiterateDocumentFixture(directory, "rmarkdown"),
      writeReleasedRLiterateDocumentFixture(directory, "quarto")
    ];
    const exactRscript = process.env.OPEN_WRANGLER_TEST_RSCRIPT;
    assert.ok(
      exactRscript && path.isAbsolute(exactRscript) && !/[\0\r\n]/u.test(exactRscript),
      "The packaged R document journey requires the runner-owned exact Rscript path."
    );
    const configuration = vscode.workspace.getConfiguration("openWrangler", fixtures[0].sourceUri);
    const filesConfiguration = vscode.workspace.getConfiguration("files", fixtures[0].sourceUri);
    const originalRscriptPath = configuration.inspect<string>("rscriptPath")?.workspaceValue;
    const originalAutoSave = filesConfiguration.inspect<string>("autoSave")?.workspaceValue;
    const resolvedAutoSave = filesConfiguration.get<string>("autoSave", "off");
    const openSessionIds = new Set<string>();
    const liveProcessIds = new Set<number>();
    const openedDocuments = new Map<string, vscode.TextDocument>();
    const initialOfficialRTerminals = new Set(vscode.window.terminals.filter(isReleasedOfficialRTerminal));
    assert.equal(
      initialOfficialRTerminals.size,
      0,
      "The literate R journey must start without an official R terminal from an earlier acceptance section."
    );
    const ownedOfficialRTerminals = new Set<vscode.Terminal>();
    let acceptanceError: { value: unknown } | undefined;

    try {
      await configuration.update("rscriptPath", exactRscript, vscode.ConfigurationTarget.Workspace);
      if (resolvedAutoSave !== "off") {
        await filesConfiguration.update("autoSave", "off", vscode.ConfigurationTarget.Workspace);
      }
      if (process.platform === "linux") {
        assert.equal(
          supportsRDocumentExecution(process.platform),
          true,
          "The focused Linux literate gate requires the product's direct-document transport."
        );
        recordAcceptanceProgress("jupyter-r:document:plain:start");
        await exerciseReleasedRDocumentJourney(testing, workbench, directory);
        assert.equal(testing.diagnostics().sessionCount, 0, "The plain R journey must release its private processes.");
        recordAcceptanceProgress("jupyter-r:document:plain:complete");
      }
      for (const fixture of fixtures) {
        const officialRTerminalsBeforeFixture = new Set(vscode.window.terminals.filter(isReleasedOfficialRTerminal));
        let ownedFixtureTerminal: vscode.Terminal | undefined;
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:open`);
        const document = await vscode.workspace.openTextDocument(fixture.sourceUri);
        if (nativeREditorTooling) {
          assert.equal(
            document.languageId,
            fixture.kind === "quarto" ? "quarto" : "rmd",
            `The official editor extensions must own the ${fixture.kind} fixture language.`
          );
        }
        openedDocuments.set(fixture.sourceUri.toString(), document);
        const sourceText = document.getText();
        const sourceVersion = document.version;
        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
        assert.equal(vscode.window.activeTextEditor?.document, document);

        if (fixture.kind === "quarto") {
          const retainPreviewForMedia = screenshotOutput !== undefined && process.platform === "linux";
          const invokeTitleAction = () =>
            invokeReleasedRDocumentTitleAction(workbench, fixture.sourceUri, fixture.variableName, screenshotOutput);
          if (!retainPreviewForMedia) {
            await invokeTitleAction();
          } else {
            assert.equal(
              nativeREditorTooling,
              true,
              "Quarto media capture requires the exact official editor tooling."
            );
            const closePreview = await openReleasedNativeQuartoPreview(workbench, fixture.sourceUri);
            try {
              await invokeTitleAction();
            } finally {
              await closePreview();
            }
          }
        } else {
          await invokeReleasedRDocumentVariable(workbench, fixture.sourceUri, fixture.variableName, false);
        }
        if (fixture.kind === "quarto") {
          await waitFor(
            () =>
              vscode.window.terminals.filter(
                (terminal) => isReleasedOfficialRTerminal(terminal) && !officialRTerminalsBeforeFixture.has(terminal)
              ).length === 1,
            10_000,
            "the Quarto title action to create one exact official R terminal"
          );
          ownedFixtureTerminal = vscode.window.terminals.find(
            (terminal) => isReleasedOfficialRTerminal(terminal) && !officialRTerminalsBeforeFixture.has(terminal)
          );
          assert.ok(ownedFixtureTerminal, "The Quarto title action must create one identifiable official R terminal.");
          ownedOfficialRTerminals.add(ownedFixtureTerminal);
        }
        const opened = await waitForReleasedRDocumentSession(
          workbench,
          testing,
          document,
          fixture.variableName,
          `the dataframe opened from a real ${fixture.kind} source document`
        );
        openSessionIds.add(opened.sessionId);
        assert.deepEqual(opened.metadata.shape, { rows: 60, columns: 4 });
        assert.deepEqual(
          opened.metadata.schema.map((column) => column.name),
          ["order_id", "market", "score", "order_date"]
        );
        assert.equal(opened.metadata.capabilities.documentInsert, true);
        assert.equal(opened.metadata.capabilities.notebookInsert, false);
        const page = await assertReleasedSessionPage(
          testing,
          opened,
          "2400001",
          `jupyter-r-document-${fixture.kind}-page`
        );
        assert.equal(page.metadata.backend, "r");
        const processId = fixture.processIdPath ? readReleasedRDocumentProcessId(fixture.processIdPath) : undefined;
        if (processId !== undefined) {
          liveProcessIds.add(processId);
          assert.equal(acceptanceProcessIsAlive(processId), true);
        }

        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:hydrate-panel`);
        await requireFreshExactSessionPanelHydration(
          testing,
          opened.sessionId,
          `The ${fixture.kind} renderer must acknowledge its first complete host snapshot.`
        );
        assert.equal(
          await withAcceptanceOperationDeadline(
            testing.synchronizePanel(opened.sessionId),
            OPEN_WRANGLER_WEBVIEW_DISCOVERY_TIMEOUT_MS,
            `the exact ${fixture.kind} panel synchronization`
          ),
          true,
          `The ${fixture.kind} session must own a synchronized live dataframe panel before preview.`
        );

        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:preview`);
        let app = await releasedRSessionApp(
          workbench,
          testing,
          opened.sessionId,
          `the ${fixture.kind} document session`
        );
        const previewed = await previewReleasedRRename(
          testing,
          workbench,
          app,
          opened.sessionId,
          "order_id",
          "record_id",
          undefined,
          fixture.variableName
        );
        app = previewed.app;
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:apply`);
        const applyButton = app
          .getByRole("region", { name: "Draft review" })
          .getByRole("button", { name: "Apply step", exact: true });
        await applyButton.waitFor({ state: "visible", timeout: 10_000 });
        assert.equal(await applyButton.isEnabled(), true, `The ${fixture.kind} Apply step button must be enabled.`);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:apply-ready`);
        await applyButton.click({ timeout: 10_000 });
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:apply-dispatched`);
        await waitFor(
          () => {
            const active = testing.activeSession();
            return (
              active?.sessionId === opened.sessionId &&
              active.metadata.draftStep === undefined &&
              active.metadata.steps.length === 1 &&
              active.metadata.steps[0]?.id === previewed.stepId &&
              active.metadata.steps[0]?.kind === "renameColumn" &&
              active.metadata.schema[0]?.name === "record_id"
            );
          },
          30_000,
          `applying the ${fixture.kind} rename`
        );
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:apply-confirmed`);
        const applied = testing.activeSession();
        assert.ok(applied, `The ${fixture.kind} rename must retain its active session.`);
        assert.match(applied.code ?? "", /record_id/u);

        testing.setActiveSession(opened.sessionId);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert`);
        const inserted = await withBoundedAcceptancePromise(
          vscode.commands.executeCommand<boolean>("openWrangler.insertRDocumentCode"),
          30_000,
          `${fixture.kind} generated-code insertion`
        );
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-completed`);
        assert.equal(inserted, true);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-result-confirmed`);
        assert.equal(testing.notebookInsertionStatus(), "applied");
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-status-confirmed`);
        assert.ok(document.version > sourceVersion);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-version-confirmed`);
        await waitFor(
          () => {
            assertReleasedRDocumentFixtureUnchanged(fixture);
            return document.isDirty;
          },
          5_000,
          `the generated ${fixture.kind} source edit to become dirty`
        );
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-dirty-confirmed`);
        assert.equal(document.getText().startsWith(sourceText), true);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-prefix-confirmed`);
        assert.match(document.getText(), /\n\n```\{r\}\n[\s\S]*record_id[\s\S]*\n```\n$/u);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-shape-confirmed`);
        assertReleasedRDocumentFixtureUnchanged(fixture);
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:insert-disk-confirmed`);

        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:close`);
        await disposePackagedSessionPanel(testing, opened.sessionId, `the ${fixture.kind} document session`);
        openSessionIds.delete(opened.sessionId);
        if (ownedFixtureTerminal) {
          const terminal = ownedFixtureTerminal;
          terminal.dispose();
          await waitFor(
            () => !vscode.window.terminals.includes(terminal),
            10_000,
            "the Quarto acceptance R terminal to close"
          );
          ownedOfficialRTerminals.delete(terminal);
        }
        if (processId !== undefined) {
          await waitFor(() => !acceptanceProcessIsAlive(processId), 10_000, `the ${fixture.kind} R process to stop`);
          liveProcessIds.delete(processId);
        }
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:revert`);
        await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
        await withBoundedAcceptancePromise(
          vscode.commands.executeCommand("workbench.action.files.revert"),
          WORKBENCH_OPERATION_TIMEOUT_MS,
          `reverting the ${fixture.kind} source without saving it`
        );
        await waitFor(() => !document.isDirty, WORKBENCH_OPERATION_TIMEOUT_MS, `the ${fixture.kind} source to revert`);
        assert.equal(document.getText(), sourceText);
        assertReleasedRDocumentFixtureUnchanged(fixture);
        const tab = textDocumentTab(fixture.sourceUri);
        if (tab) assert.equal(await vscode.window.tabGroups.close(tab, true), true);
        openedDocuments.delete(fixture.sourceUri.toString());
        recordAcceptanceProgress(`jupyter-r:document:${fixture.kind}:complete`);
      }
      await exerciseReleasedPythonQuartoDocumentJourney(
        testing,
        workbench,
        writeReleasedPythonQuartoDocumentFixture(directory)
      );
    } catch (error) {
      acceptanceError = { value: error };
    } finally {
      for (const sessionId of openSessionIds) {
        try {
          await disposePackagedSessionPanel(testing, sessionId, "the failed literate R document session");
        } catch (error) {
          acceptanceError ??= { value: error };
        }
      }
      for (const processId of liveProcessIds) {
        try {
          await waitFor(() => !acceptanceProcessIsAlive(processId), 10_000, "the failed literate R process to stop");
        } catch (error) {
          acceptanceError ??= { value: error };
        }
      }
      const remainingOwnedTerminals = new Set([
        ...ownedOfficialRTerminals,
        ...vscode.window.terminals.filter(
          (terminal) => isReleasedOfficialRTerminal(terminal) && !initialOfficialRTerminals.has(terminal)
        )
      ]);
      for (const terminal of remainingOwnedTerminals) {
        try {
          if (vscode.window.terminals.includes(terminal)) terminal.dispose();
          await waitFor(
            () => !vscode.window.terminals.includes(terminal),
            10_000,
            "the failed literate R acceptance terminal to close"
          );
        } catch (error) {
          acceptanceError ??= { value: error };
        }
      }
      for (const fixture of fixtures) {
        const document = openedDocuments.get(fixture.sourceUri.toString());
        if (document && !document.isClosed && document.isDirty) {
          try {
            await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One });
            await withBoundedAcceptancePromise(
              vscode.commands.executeCommand("workbench.action.files.revert"),
              WORKBENCH_OPERATION_TIMEOUT_MS,
              `reverting the failed ${fixture.kind} source without saving it`
            );
            await waitFor(
              () => !document.isDirty,
              WORKBENCH_OPERATION_TIMEOUT_MS,
              `the failed ${fixture.kind} source to revert`
            );
          } catch (error) {
            acceptanceError ??= { value: error };
          }
        }
        const tab = textDocumentTab(fixture.sourceUri);
        if (tab && !document?.isDirty) {
          try {
            assert.equal(await vscode.window.tabGroups.close(tab, true), true);
          } catch (error) {
            acceptanceError ??= { value: error };
          }
        }
        try {
          assertReleasedRDocumentFixtureUnchanged(fixture);
        } catch (error) {
          acceptanceError ??= { value: error };
        }
      }
      try {
        await configuration.update("rscriptPath", originalRscriptPath, vscode.ConfigurationTarget.Workspace);
      } catch (error) {
        acceptanceError ??= { value: error };
      }
      if (resolvedAutoSave !== "off") {
        try {
          await filesConfiguration.update("autoSave", originalAutoSave, vscode.ConfigurationTarget.Workspace);
        } catch (error) {
          acceptanceError ??= { value: error };
        }
      }
    }
    if (acceptanceError) throw acceptanceError.value;
  };
}
