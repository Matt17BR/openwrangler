import * as assert from "node:assert/strict";
import type * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import { operationKinds as RELEASED_R_SUPPORTED_OPERATIONS } from "../../shared/operationCatalog.generated";
import type { OpenWranglerResponse } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";
import type { ReleasedRAcceptanceCoverageProfile } from "./releasedRAcceptanceCoverage";

type ReleasedRActiveSession = NonNullable<ReturnType<TestApi["activeSession"]>>;
type ReleasedRPage = Extract<OpenWranglerResponse, { kind: "page" }>;

interface ReleasedRVariableExpectation {
  readonly name: string;
  readonly type: string;
  readonly backend: "r";
  readonly firstValue: string;
  readonly notebookInsert?: boolean;
  readonly rDataframeFlavor: "r.data.frame" | "r.tibble" | "r.data.table";
}

interface ReleasedRVariableDiscoveryDependencies {
  readonly activateReleasedNotebookVariableAction: (
    workbench: Page,
    notebook: vscode.NotebookDocument
  ) => Promise<Locator>;
  readonly arrangePackagedProductSidebar: (workbench: Page, section: "operation-catalog") => Promise<Locator>;
  readonly assertReleasedSessionPage: (
    testing: TestApi,
    active: ReleasedRActiveSession,
    firstValue: string,
    viewRequestId: string
  ) => Promise<ReleasedRPage>;
  readonly captureReleasedRJupyterOperations: (
    workbench: Page,
    sidebar: Locator,
    screenshotOutput: string
  ) => Promise<void>;
  readonly prepareReleasedRNotebookScreenshotWorkbench: (
    workbench: Page,
    notebook: vscode.NotebookDocument,
    editor: vscode.NotebookEditor
  ) => Promise<() => Promise<void>>;
  readonly recordReleasedRAcceptanceSection: (
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    section: "variable-discovery",
    boundary: "start" | "complete"
  ) => void;
  readonly releasedJupyterQuickPickRow: (quickInput: Locator, label: string) => Promise<Locator | undefined>;
  readonly showExactReleasedNotebook: (notebook: vscode.NotebookDocument) => Promise<vscode.NotebookEditor>;
  readonly waitForReleasedJupyterConsent: (
    workbench: Page,
    testing: TestApi
  ) => Promise<{ readonly allow: Locator; readonly dialog: Locator }>;
  readonly waitForReleasedVariableSession: (
    workbench: Page,
    testing: TestApi,
    notebook: vscode.NotebookDocument,
    expected: ReleasedRVariableExpectation,
    description: string
  ) => Promise<ReleasedRActiveSession>;
}

export function createReleasedRVariableDiscovery({
  activateReleasedNotebookVariableAction,
  arrangePackagedProductSidebar,
  assertReleasedSessionPage,
  captureReleasedRJupyterOperations,
  prepareReleasedRNotebookScreenshotWorkbench,
  recordReleasedRAcceptanceSection,
  releasedJupyterQuickPickRow,
  showExactReleasedNotebook,
  waitForReleasedJupyterConsent,
  waitForReleasedVariableSession
}: ReleasedRVariableDiscoveryDependencies) {
  return async function exerciseReleasedRVariableDiscovery(
    testing: TestApi,
    workbench: Page,
    notebook: vscode.NotebookDocument,
    notebookEditor: vscode.NotebookEditor,
    phase: "jupyter-r" | "jupyter-r-remote",
    coverage: ReleasedRAcceptanceCoverageProfile,
    screenshotOutput?: string
  ): Promise<ReleasedRActiveSession> {
    recordReleasedRAcceptanceSection(phase, coverage, "variable-discovery", "start");

    const consent = await waitForReleasedJupyterConsent(workbench, testing);
    await consent.allow.click();
    await consent.dialog.waitFor({ state: "hidden", timeout: 10_000 });

    let sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
    let operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
    for (const [name, flavor] of [
      ["orders_frame", "data.frame"],
      ["orders_tibble", "tibble"],
      ["orders_table", "data.table"],
      ["collapse_frame", "data.frame"],
      ["collapse_tibble", "tibble"],
      ["collapse_table", "data.table"]
    ] as const) {
      const row = operations.getByRole("treeitem", { name: new RegExp(`^${name}\\b`, "u") });
      await row.waitFor({ state: "visible", timeout: 90_000 });
      assert.match(
        (await row.innerText()).replace(/\s+/gu, " "),
        new RegExp(`${name}.*R · ${flavor}`, "u"),
        `Operations must label ${name} with its native R dataframe flavor.`
      );
    }
    for (const name of ["collapse_grouped", "collapse_indexed"] as const) {
      assert.equal(
        await operations.getByRole("treeitem", { name: new RegExp(`^${name}\\b`, "u") }).count(),
        0,
        `Operations must omit unsupported ${name}.`
      );
    }

    const actionNotebookEditor = await showExactReleasedNotebook(notebook);
    assert.equal(
      actionNotebookEditor,
      notebookEditor,
      "The first R toolbar action must retain the exact editor used to execute setup."
    );
    const restoreOperationsWorkbench = screenshotOutput
      ? await prepareReleasedRNotebookScreenshotWorkbench(workbench, notebook, notebookEditor)
      : undefined;
    let picker: Locator | undefined;
    try {
      if (screenshotOutput) {
        sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
        operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
        await captureReleasedRJupyterOperations(workbench, sidebar, screenshotOutput);
      }
      picker = await activateReleasedNotebookVariableAction(workbench, notebook);
      for (const [name, flavor] of [
        ["orders_frame", "data.frame"],
        ["orders_tibble", "tibble"],
        ["orders_table", "data.table"],
        ["collapse_frame", "data.frame"],
        ["collapse_tibble", "tibble"],
        ["collapse_table", "data.table"]
      ] as const) {
        const row = await releasedJupyterQuickPickRow(picker, name);
        assert.ok(row, `The real R variable picker must expose ${name}.`);
        assert.match(
          (await row.innerText()).replace(/\s+/gu, " "),
          new RegExp(`R · ${flavor}.*Live notebook session`, "u")
        );
      }
      for (const name of ["collapse_grouped", "collapse_indexed"] as const) {
        assert.equal(
          await releasedJupyterQuickPickRow(picker, name),
          undefined,
          `The real R variable picker must omit unsupported ${name}.`
        );
      }
      await workbench.keyboard.press("Escape");
      await picker.waitFor({ state: "hidden", timeout: 10_000 });
    } finally {
      await restoreOperationsWorkbench?.();
    }
    sidebar = await arrangePackagedProductSidebar(workbench, "operation-catalog");
    operations = sidebar.getByRole("tree", { name: /Operations/u }).first();
    const ordersOperation = operations.getByRole("treeitem", { name: /^orders_frame\b/u });
    await ordersOperation.waitFor({ state: "visible", timeout: 10_000 });
    await ordersOperation.click();
    recordReleasedRAcceptanceSection(phase, coverage, "variable-discovery", "complete");

    const base = await waitForReleasedVariableSession(
      workbench,
      testing,
      notebook,
      {
        name: "orders_frame",
        type: "data.frame",
        backend: "r",
        rDataframeFlavor: "r.data.frame",
        firstValue: "1",
        notebookInsert: true
      },
      "the orders R data.frame opened from Operations"
    );
    await assertReleasedSessionPage(testing, base, "1", `${phase}-base-page`);
    assert.deepEqual(base.metadata.capabilities, {
      editable: true,
      lazy: false,
      cancel: false,
      exportCsv: false,
      exportParquet: false,
      notebookInsert: true,
      filter: true,
      sort: true,
      profile: true,
      columnValues: true,
      supportedOperations: RELEASED_R_SUPPORTED_OPERATIONS
    });
    return base;
  };
}
