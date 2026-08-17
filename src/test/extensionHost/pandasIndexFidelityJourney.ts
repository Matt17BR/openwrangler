import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Locator, Page } from "playwright-core";
import type { FilterModel } from "../../shared/protocol";
import { exportCleanedDataThroughWorkbench } from "./cleanedDataExport";
import type { TestApi } from "./extensionHostTestApi";

export interface PandasIndexFidelityJourneyOptions {
  readonly testing: TestApi;
  readonly notebookUri: vscode.Uri;
  readonly executeNotebook: (code: string) => Promise<string>;
  readonly workbench: Page;
  readonly sessionApp: (sessionId: string, description: string) => Promise<Locator>;
  readonly disposeSession: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly createTemporaryDirectory: () => string;
  readonly cleanupTemporaryDirectory: (directory: string) => void;
  readonly recordProgress: (checkpoint: string) => void;
  readonly waitFor: (predicate: () => boolean, timeoutMs: number, expectation: string) => Promise<void>;
  readonly sessionOpenTimeoutMs: number;
}

const GRID_COLUMN_WINDOW = { columnOffset: 0, columnLimit: 16 } as const;
const EMPTY_VIEW: FilterModel = { logic: "and", filters: [], sort: [] };

export async function exercisePandasIndexFidelityJourney(options: PandasIndexFidelityJourneyOptions): Promise<void> {
  const { testing } = options;
  assert.equal(testing.diagnostics().sessionCount, 0, "Pandas index fidelity must start without a retained session.");

  const directory = options.createTemporaryDirectory();
  const preservedCsvPath = path.join(directory, "pandas-index-preserved.csv");
  const omittedParquetPath = path.join(directory, "pandas-index-omitted.parquet");
  let sessionId: string | undefined;
  let operationError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    options.recordProgress("verify:notebook:pandas-index:open");
    await vscode.commands.executeCommand("openWrangler.launchDataViewer", {
      variableName: "index_frame",
      fileName: options.notebookUri
    });
    await options.waitFor(
      () => {
        const active = testing.activeSession();
        return active?.metadata.source.variableName === "index_frame" && active.metadata.backend === "pandas";
      },
      options.sessionOpenTimeoutMs,
      "the named-MultiIndex Pandas notebook session"
    );

    const active = testing.activeSession();
    assert.ok(active, "The named-MultiIndex Pandas notebook session must become active.");
    sessionId = active.sessionId;
    assert.deepEqual(active.metadata.rowAxis, {
      kind: "multiIndex",
      levelNames: ["region", "account"]
    });
    assert.deepEqual(
      active.metadata.schema.map((column) => column.name),
      ["amount", "city"],
      "Pandas index levels must remain metadata rather than ordinary columns."
    );

    options.recordProgress("verify:notebook:pandas-index:page");
    const initialPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "pandas-index-initial-page",
      sessionId,
      revision: active.metadata.revision,
      offset: 0,
      limit: 10,
      filterModel: EMPTY_VIEW
    });
    assert.equal(initialPage.kind, "page", "The named-MultiIndex page must resolve.");
    if (initialPage.kind !== "page") throw new Error("The named-MultiIndex page did not resolve.");
    assert.deepEqual(
      initialPage.page.rows.map((row) => row.rowLabel),
      ["north · acct-b", "south · acct-a", "north · acct-c"],
      "The live page must expose exact ordered MultiIndex labels."
    );
    assert.equal(initialPage.page.columnIds.length, 2, "Index levels must not consume transported data columns.");

    const app = await options.sessionApp(sessionId, "the named-MultiIndex Pandas session");
    const rowAxisHeader = app.getByRole("columnheader", {
      name: "region / account row labels",
      exact: true
    });
    await rowAxisHeader.waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await rowAxisHeader.innerText()).trim(), "region / account");
    await app
      .getByRole("rowheader", { name: "Row 1, region / account north · acct-b", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(
      await app.getByRole("columnheader", { name: /^amount/u }).getAttribute("aria-colindex"),
      "2",
      "The first ordinary column must follow the row-axis presentation column."
    );
    assert.equal(
      await app.getByRole("columnheader", { name: /^city/u }).getAttribute("aria-colindex"),
      "3",
      "The second ordinary column must retain its full-schema coordinate."
    );

    options.recordProgress("verify:notebook:pandas-index:export-preserve-csv");
    await exportCleanedDataThroughWorkbench(app, options.workbench, preservedCsvPath, "csv", {
      rowAxisPolicy: "preserve"
    });
    const csvText = readFileSync(preservedCsvPath, "utf8").replace(/\r\n/gu, "\n");
    assert.equal(
      csvText,
      ["region,account,amount,city", "north,acct-b,10,Oslo", "south,acct-a,30,Rome", "north,acct-c,20,Lima", ""].join(
        "\n"
      ),
      "Preserving the Pandas index must serialize its exact named levels before ordinary columns."
    );

    options.recordProgress("verify:notebook:pandas-index:export-omit-parquet");
    await exportCleanedDataThroughWorkbench(app, options.workbench, omittedParquetPath, "parquet", {
      rowAxisPolicy: "omit"
    });
    const exportVerification = await options.executeNotebook(
      [
        `index_omitted_export = pd.read_parquet(${JSON.stringify(omittedParquetPath)})`,
        "assert list(index_omitted_export.columns) == ['amount', 'city']",
        "assert isinstance(index_omitted_export.index, pd.RangeIndex)",
        "assert index_omitted_export.index.tolist() == [0, 1, 2]",
        "assert index_omitted_export.to_dict(orient='list') == {'amount': [10, 30, 20], 'city': ['Oslo', 'Rome', 'Lima']}",
        "print('PANDAS_INDEX_EXPORT_OK')"
      ].join("\n")
    );
    assert.match(exportVerification, /PANDAS_INDEX_EXPORT_OK/u);

    const amountColumn = active.metadata.schema.find((column) => column.name === "amount");
    assert.ok(amountColumn, "The Pandas index fixture must expose amount.");
    const filteredView: FilterModel = {
      logic: "and",
      filters: [
        {
          column: "amount",
          type: "integer",
          predicates: [{ kind: "predicate", operator: "gt", value: 10 }]
        }
      ],
      sort: [{ column: "amount", direction: "desc", nulls: "last" }]
    };
    options.recordProgress("verify:notebook:pandas-index:filtered-page");
    const filteredPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "pandas-index-filtered-page",
      sessionId,
      revision: initialPage.revision,
      offset: 0,
      limit: 10,
      filterModel: filteredView
    });
    assert.equal(filteredPage.kind, "page", "The filtered named-MultiIndex page must resolve.");
    if (filteredPage.kind !== "page") throw new Error("The filtered named-MultiIndex page did not resolve.");
    assert.deepEqual(
      filteredPage.page.rows.map((row) => row.rowLabel),
      ["south · acct-a", "north · acct-c"],
      "Row labels must come from the exact post-filter and post-sort Pandas slice."
    );

    const restoredPage = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      viewRequestId: "pandas-index-restored-page",
      sessionId,
      revision: filteredPage.revision,
      offset: 0,
      limit: 10,
      filterModel: EMPTY_VIEW
    });
    assert.equal(restoredPage.kind, "page", "The unfiltered named-MultiIndex page must restore.");
    if (restoredPage.kind !== "page") throw new Error("The unfiltered named-MultiIndex page did not restore.");

    options.recordProgress("verify:notebook:pandas-index:preview-reset");
    const preview = await testing.request({
      kind: "previewStep",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: restoredPage.revision,
      step: {
        id: "pandas-index-reset",
        kind: "customCode",
        params: { code: "result = df.reset_index(drop=True)" }
      },
      offset: 0,
      limit: 10
    });
    assert.equal(preview.kind, "stepPreview", "Resetting the Pandas index must preview.");
    if (preview.kind !== "stepPreview") throw new Error("Resetting the Pandas index did not preview.");
    assert.deepEqual(preview.metadata.rowAxis, { kind: "positional", levelNames: [] });
    assert.deepEqual(
      preview.page.rows.map((row) => row.rowLabel),
      [undefined, undefined, undefined],
      "A positional default index must not masquerade as a user row label."
    );
    assert.match(preview.code, /reset_index\(drop=True\)/u);

    const applied = await testing.request({
      kind: "applyDraft",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: preview.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(applied.kind, "planUpdated", "The Pandas index reset must apply.");
    if (applied.kind !== "planUpdated") throw new Error("The Pandas index reset did not apply.");
    assert.deepEqual(applied.metadata.rowAxis, { kind: "positional", levelNames: [] });

    options.recordProgress("verify:notebook:pandas-index:inspection");
    const inspection = await testing.request({
      kind: "inspectStep",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: applied.revision,
      stepId: "pandas-index-reset",
      offset: 0,
      limit: 10
    });
    assert.equal(inspection.kind, "stepInspection", "The Pandas index reset must be inspectable.");
    if (inspection.kind !== "stepInspection") throw new Error("The Pandas index reset inspection did not resolve.");
    assert.deepEqual(inspection.inputRowAxis, { kind: "multiIndex", levelNames: ["region", "account"] });
    assert.deepEqual(inspection.outputRowAxis, { kind: "positional", levelNames: [] });
    assert.deepEqual(
      inspection.inputPage.rows.map((row) => row.rowLabel),
      ["north · acct-b", "south · acct-a", "north · acct-c"]
    );
    assert.deepEqual(
      inspection.outputPage.rows.map((row) => row.rowLabel),
      [undefined, undefined, undefined]
    );

    options.recordProgress("verify:notebook:pandas-index:undo");
    const undone = await testing.request({
      kind: "undoStep",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: applied.revision,
      offset: 0,
      limit: 10
    });
    assert.equal(undone.kind, "planUpdated", "Undo must restore the named Pandas index.");
    if (undone.kind !== "planUpdated") throw new Error("Undo did not restore the named Pandas index.");
    assert.deepEqual(undone.metadata.rowAxis, { kind: "multiIndex", levelNames: ["region", "account"] });
    assert.deepEqual(
      undone.page.rows.map((row) => row.rowLabel),
      ["north · acct-b", "south · acct-a", "north · acct-c"]
    );

    const sourceVerification = await options.executeNotebook(
      [
        "assert index_frame.equals(index_frame_source)",
        "assert index_frame.index.equals(index_frame_source.index)",
        "assert list(index_frame.index.names) == ['region', 'account']",
        "print('PANDAS_INDEX_SOURCE_UNCHANGED')"
      ].join("\n")
    );
    assert.match(sourceVerification, /PANDAS_INDEX_SOURCE_UNCHANGED/u);

    options.recordProgress("verify:notebook:pandas-index:close");
    await options.disposeSession(testing, sessionId, "the Pandas index-fidelity notebook session");
    sessionId = undefined;
    await options.waitFor(
      () => testing.diagnostics().sessionCount === 0,
      10_000,
      "the Pandas index-fidelity notebook session to close"
    );
    options.recordProgress("verify:notebook:pandas-index:complete");
  } catch (error) {
    operationError = error;
  }

  if (sessionId !== undefined) {
    try {
      await options.disposeSession(testing, sessionId, "the failed Pandas index-fidelity notebook session");
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    options.cleanupTemporaryDirectory(directory);
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Pandas index-fidelity acceptance failed and did not clean up fully."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Pandas index-fidelity acceptance cleanup failed.");
  }
}

export function pandasIndexFixtureSetupCode(): readonly string[] {
  return [
    "index_frame = pd.DataFrame(",
    "    {'amount': [10, 30, 20], 'city': ['Oslo', 'Rome', 'Lima']},",
    "    index=pd.MultiIndex.from_tuples(",
    "        [('north', 'acct-b'), ('south', 'acct-a'), ('north', 'acct-c')],",
    "        names=['region', 'account'],",
    "    ),",
    ")",
    "index_frame_source = index_frame.copy(deep=True)"
  ];
}
