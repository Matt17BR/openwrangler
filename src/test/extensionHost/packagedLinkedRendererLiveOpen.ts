import * as assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { Page } from "playwright-core";
import { OPEN_WRANGLER_MIME_V2, type NotebookOutputPayload } from "../../shared/notebookOutput";
import type { ColumnReference, FilterModel, GridPage, SessionMetadata } from "../../shared/protocol";
import type { TestApi } from "./extensionHostTestApi";
import { notebookTab } from "./rendererProvenance";

interface PackagedLinkedRendererJupyterApi {
  readonly testing: {
    execute(uri: vscode.Uri, code: string): Promise<string>;
    stats(uri: vscode.Uri): { readonly generation: number; readonly executions: number } | undefined;
  };
}

type FakeJupyterApi = PackagedLinkedRendererJupyterApi;

interface PackagedLinkedRendererButton {
  evaluate<Result>(pageFunction: (element: unknown) => Result | Promise<Result>): Promise<Result>;
  dispose(): Promise<void>;
}

export interface PackagedLinkedRendererLiveDependencies {
  readonly columnReference: (metadata: SessionMetadata, name: string) => ColumnReference;
  readonly connectToEditorWorkbench: () => Promise<Page>;
  readonly disposePackagedSessionPanel: (testing: TestApi, sessionId: string, description: string) => Promise<void>;
  readonly isOpenWranglerSessionTab: (tab: vscode.Tab) => boolean;
  readonly recordAcceptanceProgress: (checkpoint: string) => void;
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
  ) => Promise<PackagedLinkedRendererButton>;
  readonly sessionOpenAcceptanceTimeoutMs: number;
}

export function createPackagedLinkedRendererLiveOpen(
  dependencies: PackagedLinkedRendererLiveDependencies
): (testing: TestApi, jupyter: PackagedLinkedRendererJupyterApi, directory: string) => Promise<void> {
  const {
    columnReference,
    connectToEditorWorkbench,
    disposePackagedSessionPanel,
    isOpenWranglerSessionTab,
    recordAcceptanceProgress,
    waitFor,
    waitForNotebookRendererButton,
    sessionOpenAcceptanceTimeoutMs
  } = dependencies;
  const SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS = sessionOpenAcceptanceTimeoutMs;

  async function exercisePackagedLinkedRendererLiveOpen(
    testing: TestApi,
    jupyter: FakeJupyterApi,
    directory: string
  ): Promise<void> {
    const label = "linked renderer live acceptance";
    const variableName = "saved_preview_frame";
    const snapshotPath = path.join(directory, "renderer-linked-live.ipynb");
    const schema: SessionMetadata["schema"] = [
      { id: "c:city", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
      { id: "c:score", name: "score", position: 1, rawType: "Int64", type: "integer", nullable: true },
      { id: "c:group", name: "group", position: 2, rawType: "String", type: "string", nullable: false }
    ];
    const payload: NotebookOutputPayload = {
      mimeVersion: 2,
      metadata: {
        protocolVersion: 2,
        sessionId: "claimed-snapshot-session",
        revision: 0,
        backend: "polars",
        mode: "viewing",
        source: { kind: "notebookOutput", label, variableName },
        capabilities: {
          editable: false,
          lazy: false,
          cancel: false,
          exportCsv: false,
          exportParquet: false,
          notebookInsert: false
        },
        shape: { rows: 99, columns: schema.length },
        filteredShape: { rows: 99, columns: schema.length },
        schema,
        filterModel: { logic: "and", filters: [], sort: [] },
        steps: []
      },
      page: {
        offset: 0,
        limit: 99,
        totalRows: 99,
        columnIds: schema.map((column) => column.id),
        rows: [
          snapshotRow("r:capture:0", 0, "Berlin", 2, "b"),
          snapshotRow("r:capture:1", 1, "Amsterdam", 5, "a"),
          snapshotRow("r:capture:2", 2, "Berlin", 7, "a"),
          snapshotRow("r:capture:3", 3, "Cairo", null, "c")
        ]
      },
      summaries: []
    };
    writeFileSync(
      snapshotPath,
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
                  "text/plain": ["Open Wrangler linked live preview"],
                  [OPEN_WRANGLER_MIME_V2]: payload
                }
              }
            ],
            source: [variableName]
          }
        ],
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" } },
        nbformat: 4,
        nbformat_minor: 5
      })
    );

    let snapshotNotebook: vscode.NotebookDocument | undefined;
    try {
      recordAcceptanceProgress("verify:notebook-renderer-linked-live:open");
      snapshotNotebook = await vscode.workspace.openNotebookDocument(vscode.Uri.file(snapshotPath));
      const snapshotEditor = await vscode.window.showNotebookDocument(snapshotNotebook, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false
      });
      snapshotEditor.revealRange(new vscode.NotebookRange(0, 1), vscode.NotebookEditorRevealType.InCenter);
      await jupyter.testing.execute(
        snapshotNotebook.uri,
        [
          "import polars as pl",
          `${variableName} = pl.DataFrame({`,
          "    'city': ['Berlin', 'Amsterdam', 'Berlin', 'Cairo'],",
          "    'score': [2, 5, 7, None],",
          "    'group': ['b', 'a', 'a', 'c'],",
          "})"
        ].join("\n")
      );
      const liveKernelBaseline = jupyter.testing.stats(snapshotNotebook.uri);
      assert.ok(liveKernelBaseline, "The linked renderer fixture must own one user-started kernel.");

      const workbench = await connectToEditorWorkbench();
      const button = await waitForNotebookRendererButton(workbench, label, "Open in Open Wrangler");
      recordAcceptanceProgress("verify:notebook-renderer-linked-live:click");
      try {
        await button.evaluate((candidate: unknown) => (candidate as { click(): void }).click());
      } finally {
        await button.dispose();
      }
      await waitFor(
        () => {
          const source = testing.activeSession()?.metadata.source;
          return (
            source?.kind === "notebookVariable" &&
            source.variableName === variableName &&
            source.uri === snapshotNotebook?.uri.toString()
          );
        },
        SESSION_OPEN_ACCEPTANCE_TIMEOUT_MS,
        "the linked MIME-v2 renderer output to open its complete current live dataframe"
      );

      const active = testing.activeSession();
      assert.ok(active, "The linked renderer output must become an active live-variable session.");
      assert.notEqual(
        active.sessionId,
        payload.metadata.sessionId,
        "The live session must not trust a saved identity."
      );
      assert.equal(active.metadata.sessionId, active.sessionId);
      assert.deepEqual(active.metadata.source, {
        kind: "notebookVariable",
        label: variableName,
        variableName,
        uri: snapshotNotebook.uri.toString()
      });
      assert.equal(active.metadata.mode, "editing");
      assert.equal(active.metadata.revision, 0);
      assert.deepEqual(active.metadata.shape, { rows: 4, columns: 3 });
      assert.deepEqual(active.metadata.filteredShape, { rows: 4, columns: 3 });
      assert.deepEqual(active.metadata.capabilities, {
        editable: true,
        lazy: false,
        cancel: false,
        exportCsv: true,
        exportParquet: true,
        notebookInsert: true
      });
      assert.deepEqual(active.metadata.filterModel, { logic: "and", filters: [], sort: [] });
      assert.deepEqual(active.metadata.steps, []);
      assert.equal(active.metadata.latestStepInputSchema, undefined);
      assert.equal(active.metadata.draftStep, undefined);
      assert.equal(active.metadata.stats, undefined);
      const liveScore = columnReference(active.metadata, "score");
      assert.notEqual(
        liveScore.id,
        payload.metadata.schema.find((column) => column.name === "score")?.id,
        "The live session must generate its own column identities instead of trusting the saved preview."
      );
      const diagnostic = testing.diagnostics().sessions.find((session) => session.publicId === active.sessionId);
      assert.ok(diagnostic, "The linked live session must be coordinator-owned.");
      assert.notEqual(diagnostic.runtimeId, payload.metadata.sessionId);
      assert.notEqual(diagnostic.runtimeId, diagnostic.publicId);
      assert.ok(
        (jupyter.testing.stats(snapshotNotebook.uri)?.executions ?? 0) > liveKernelBaseline.executions,
        "Opening the linked renderer action must execute against its exact live kernel."
      );

      const filteredModel: FilterModel = {
        logic: "and",
        filters: [
          {
            column: "group",
            type: "string",
            logic: "and",
            predicates: [{ kind: "predicate", operator: "equals", value: "a" }]
          }
        ],
        sort: [{ column: "score", direction: "desc", nulls: "last" }]
      };
      recordAcceptanceProgress("verify:notebook-renderer-linked-live:page");
      const projected = await testing.request({
        kind: "getPage",
        sessionId: active.sessionId,
        revision: active.metadata.revision,
        viewRequestId: "linked-renderer-live-page",
        offset: 0,
        limit: 2,
        columnOffset: 1,
        columnLimit: 1,
        filterModel: filteredModel
      });
      assert.equal(projected.kind, "page");
      if (projected.kind !== "page") throw new Error("The linked live projected page did not resolve.");
      assert.deepEqual(projected.page.columnIds, [liveScore.id]);
      assert.deepEqual(
        projected.page.rows.map((row) => row.values[0]?.display),
        ["7", "5"]
      );
      assert.equal(projected.page.totalRows, 2);
      assert.deepEqual(projected.metadata.filteredShape, { rows: 2, columns: 3 });

      recordAcceptanceProgress("verify:notebook-renderer-linked-live:summary");
      const summary = await testing.request({
        kind: "getSummary",
        sessionId: active.sessionId,
        revision: projected.revision,
        viewRequestId: "linked-renderer-live-summary",
        filterModel: filteredModel,
        columnIds: [liveScore.id]
      });
      assert.equal(summary.kind, "summary");
      if (summary.kind !== "summary") throw new Error("The linked live summary did not resolve.");
      assert.deepEqual(summary.summaries, [
        {
          columnId: liveScore.id,
          column: "score",
          type: "integer",
          rawType: "Int64",
          totalCount: 2,
          nullCount: 0,
          nanCount: 0,
          distinctCount: 2,
          topValues: [
            { value: "7", count: 1 },
            { value: "5", count: 1 }
          ],
          numeric: {
            min: 5,
            max: 7,
            sum: 12,
            mean: 6,
            median: 6,
            std: Math.SQRT2,
            exactMin: { kind: "integer", raw: 5, display: "5", isNull: false, isNaN: false },
            exactMax: { kind: "integer", raw: 7, display: "7", isNull: false, isNaN: false },
            exactSum: { kind: "integer", raw: 12, display: "12", isNull: false, isNaN: false }
          },
          visualization: {
            kind: "numeric",
            bins: [
              { min: 5, max: 6, count: 1 },
              { min: 6, max: 7, count: 1 }
            ]
          }
        }
      ]);

      recordAcceptanceProgress("verify:notebook-renderer-linked-live:statistics");
      const statistics = await testing.request({
        kind: "getDatasetStats",
        sessionId: active.sessionId,
        revision: projected.revision,
        viewRequestId: "linked-renderer-live-statistics",
        filterModel: { logic: "and", filters: [], sort: [] }
      });
      assert.equal(statistics.kind, "datasetStats");
      if (statistics.kind !== "datasetStats") throw new Error("The linked live statistics did not resolve.");
      assert.deepEqual(statistics.stats, {
        missingCells: 1,
        missingRows: 1,
        duplicateRows: 0,
        missingValuesByColumn: [
          { column: "city", count: 0 },
          { column: "score", count: 1 },
          { column: "group", count: 0 }
        ]
      });

      recordAcceptanceProgress("verify:notebook-renderer-linked-live:values");
      const values = await testing.request({
        kind: "getColumnValues",
        sessionId: active.sessionId,
        revision: projected.revision,
        viewRequestId: "linked-renderer-live-values",
        column: "city",
        search: "ber",
        limit: 100,
        filterModel: filteredModel
      });
      assert.equal(values.kind, "columnValues");
      if (values.kind !== "columnValues") throw new Error("The linked live values query did not resolve.");
      assert.deepEqual(values.values, [
        {
          value: "Berlin",
          count: 1,
          selectionValue: {
            kind: "typedSelection",
            version: 1,
            columnType: "string",
            cell: { kind: "string", raw: "Berlin", display: "Berlin", isNull: false, isNaN: false }
          }
        }
      ]);
      assert.equal(values.hasMore, false);

      recordAcceptanceProgress("verify:notebook-renderer-linked-live:close");
      await disposePackagedSessionPanel(testing, active.sessionId, "the exact linked live session");
      assert.deepEqual(
        testing.diagnostics().sessions,
        [],
        `An earlier packaged notebook session leaked into linked-live cleanup: ${JSON.stringify(testing.diagnostics().sessions)}`
      );
      assert.ok(
        jupyter.testing.stats(snapshotNotebook.uri),
        "Closing the Open Wrangler panel must not stop the user's kernel."
      );
      const snapshotTab = notebookTab(snapshotNotebook.uri);
      if (snapshotTab) assert.equal(await vscode.window.tabGroups.close(snapshotTab, true), true);
      recordAcceptanceProgress("verify:notebook-renderer-linked-live:complete");
    } catch (error) {
      await bestEffortLinkedRendererCleanup(testing, snapshotNotebook, label, variableName);
      throw error;
    }
  }

  function snapshotRow(
    id: string,
    rowNumber: number,
    city: string,
    score: number | null,
    group: string
  ): GridPage["rows"][number] {
    return {
      id,
      rowNumber,
      values: [
        { kind: "string", raw: city, display: city, isNull: false, isNaN: false },
        score === null
          ? { kind: "null", raw: null, display: "", isNull: true, isNaN: false }
          : { kind: "integer", raw: score, display: String(score), isNull: false, isNaN: false },
        { kind: "string", raw: group, display: group, isNull: false, isNaN: false }
      ]
    };
  }

  async function bestEffortLinkedRendererCleanup(
    testing: TestApi,
    notebook: vscode.NotebookDocument | undefined,
    label: string,
    variableName: string
  ): Promise<void> {
    const active = testing.activeSession();
    if (active?.metadata.source.kind === "notebookVariable" && active.metadata.source.variableName === variableName) {
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
    const tabs = linkedRendererTabs(notebook, label);
    if (tabs.length > 0) {
      try {
        await vscode.window.tabGroups.close(tabs, true);
      } catch {
        // Preserve the original acceptance failure.
      }
    }
  }

  function linkedRendererTabs(notebook: vscode.NotebookDocument | undefined, label: string): vscode.Tab[] {
    return [
      ...(notebook ? [notebookTab(notebook.uri)] : []),
      ...vscode.window.tabGroups.all
        .flatMap((group) => group.tabs)
        .filter((tab) => tab.label === `Open Wrangler: ${label}` || isOpenWranglerSessionTab(tab))
    ].filter((tab): tab is vscode.Tab => Boolean(tab));
  }

  return exercisePackagedLinkedRendererLiveOpen;
}
