import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCoordinator } from "../extension/sessionCoordinator";
import {
  closeNotebook,
  command,
  deferred,
  discoveryOutputs,
  editor,
  jupyterBridgeApi,
  jupyterBridgeMocks,
  notebook,
  preflightText,
  rDiscoveryOutputs,
  register,
  resetNotebookCommandTest,
  rNotebookKernel
} from "./jupyterBridge.testSupport";

const notebookMocks = jupyterBridgeMocks();
const {
  buildNotebookVariableDiscoveryCode,
  buildPySparkNotebookPreflightCode,
  discoverVariablesForSelectedKernel,
  isRNotebookVariableDiscovery,
  openDiscoveredRNotebookVariable,
  parsePySparkNotebookPreflightOutput
} = jupyterBridgeApi();

describe("notebook variable discovery", () => {
  beforeEach(resetNotebookCommandTest);

  it("populates a branded typed picker with concrete dataframe backends", async () => {
    const original = notebook("file:///workspace/typed.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.executeCode.mockImplementationOnce((code) =>
      discoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [
          { name: "duck_relation", type: "_duckdb.DuckDBPyRelation", backend: "duckdb" },
          { name: "pandas_current_frame", type: "pandas.DataFrame", backend: "pandas" },
          { name: "pandas_current_series", type: "pandas.Series", backend: "pandas" },
          { name: "pandas_legacy_frame", type: "pandas.core.frame.DataFrame", backend: "pandas" },
          { name: "pandas_legacy_series", type: "pandas.core.series.Series", backend: "pandas" },
          { name: "polars_frame", type: "polars.dataframe.frame.DataFrame", backend: "polars" },
          { name: "polars_lazy", type: "polars.lazyframe.frame.LazyFrame", backend: "polars" },
          { name: "polars_series", type: "polars.series.series.Series", backend: "polars" },
          {
            name: "spark_classic",
            type: "pyspark.sql.classic.dataframe.DataFrame",
            backend: "pyspark"
          },
          {
            name: "spark_connect",
            type: "pyspark.sql.connect.dataframe.DataFrame",
            backend: "pyspark"
          }
        ]
      })
    );
    notebookMocks.showQuickPick.mockImplementationOnce(async (items) =>
      items.find(
        (item) => typeof item === "object" && item !== null && (item as { label?: unknown }).label === "spark_connect"
      )
    );
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.openNotebookVariable")();

    const [items, options] = notebookMocks.showQuickPick.mock.calls[0] ?? [];
    expect(options).toMatchObject({
      title: "Open Wrangler: Open Notebook Variable",
      placeHolder: "Open Wrangler: Select a dataframe variable from the active Jupyter kernel",
      matchOnDescription: true,
      matchOnDetail: true
    });
    expect(items).toEqual([
      expect.objectContaining({
        label: "duck_relation",
        description: "DuckDB · DuckDBPyRelation",
        detail: "_duckdb.DuckDBPyRelation · Live viewing-only session"
      }),
      expect.objectContaining({
        label: "pandas_current_frame",
        description: "Pandas · DataFrame",
        detail: "pandas.DataFrame · Live notebook session"
      }),
      expect.objectContaining({ label: "pandas_current_series", description: "Pandas · Series" }),
      expect.objectContaining({
        label: "pandas_legacy_frame",
        description: "Pandas · DataFrame",
        detail: "pandas.core.frame.DataFrame · Live notebook session"
      }),
      expect.objectContaining({ label: "pandas_legacy_series", description: "Pandas · Series" }),
      expect.objectContaining({ label: "polars_frame", description: "Polars · DataFrame" }),
      expect.objectContaining({ label: "polars_lazy", description: "Polars · LazyFrame" }),
      expect.objectContaining({ label: "polars_series", description: "Polars · Series" }),
      expect.objectContaining({ label: "spark_classic", description: "PySpark Classic · DataFrame" }),
      expect.objectContaining({
        label: "spark_connect",
        description: "PySpark Connect · DataFrame",
        detail: "Viewing only · First page loads without counting rows · PySpark 4.2.x required"
      })
    ]);
    const sparkItems = (items as readonly { description?: string; detail?: string }[]).filter((item) =>
      item.description?.startsWith("PySpark ")
    );
    expect(sparkItems).toHaveLength(2);
    expect(sparkItems.every((item) => (item.detail?.length ?? Number.POSITIVE_INFINITY) <= 80)).toBe(true);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "spark_connect",
        variableName: "spark_connect",
        uri: original.uri.toString()
      },
      "pyspark"
    );
    expect(notebookMocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(notebookMocks.restoreEditorGroupAfterQuickPick.mock.invocationCallOrder[0]).toBeLessThan(
      notebookMocks.createPanel.mock.invocationCallOrder[0]!
    );
  });

  it("opens a discovered DuckDB relation as a pinned live viewing session", async () => {
    const original = notebook("file:///workspace/duckdb.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.executeCode.mockImplementationOnce((code) =>
      discoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "duck_relation", type: "_duckdb.DuckDBPyRelation", backend: "duckdb" }]
      })
    );
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "duck_relation",
        variableName: "duck_relation",
        uri: original.uri.toString()
      },
      "duckdb"
    );
    expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("discovers an R tibble and opens it through the native R bridge", async () => {
    const original = notebook("file:///workspace/r.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    const rKernel = rNotebookKernel();
    notebookMocks.getKernel.mockResolvedValue(rKernel);
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator, coordinatedBridge } = register();

    await command("openWrangler.openNotebookVariable")();

    const [items] = notebookMocks.showQuickPick.mock.calls[0] ?? [];
    expect(items).toEqual([
      expect.objectContaining({
        label: "sales_tbl",
        description: "R · tibble",
        detail: "Live notebook session"
      })
    ]);
    expect(notebookMocks.executeCode).toHaveBeenCalledTimes(2);
    expect(notebookMocks.kernelOrigins).toEqual([]);
    expect(notebookMocks.rKernelOrigins).toEqual([{ uri: original.uri.toString(), document: original }]);
    expect(notebookMocks.rVerifiedSelections).toEqual([
      expect.objectContaining({
        variable: expect.objectContaining({ name: "sales_tbl", dataframeFlavor: "r.tibble" })
      })
    ]);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "sales_tbl",
        variableName: "sales_tbl",
        uri: original.uri.toString()
      },
      "r"
    );
    expect(notebookMocks.restoreEditorGroupAfterQuickPick).toHaveBeenCalledOnce();
    expect(notebookMocks.restoreEditorGroupAfterQuickPick.mock.invocationCallOrder[0]).toBeLessThan(
      notebookMocks.createPanel.mock.invocationCallOrder[0]!
    );
    expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("opens a cached R descriptor through its original notebook discovery", async () => {
    const original = notebook("file:///workspace/r-cached.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel());
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator, coordinatedBridge } = register();

    const discovery = await discoverVariablesForSelectedKernel(original);
    expect(isRNotebookVariableDiscovery(discovery)).toBe(true);
    if (!isRNotebookVariableDiscovery(discovery)) throw new Error("Expected an R notebook discovery.");
    await openDiscoveredRNotebookVariable(
      context,
      coordinator as unknown as SessionCoordinator,
      original,
      discovery,
      discovery.variables[0]!
    );

    expect(notebookMocks.executeCode).toHaveBeenCalledTimes(2);
    expect(notebookMocks.rKernelOrigins).toEqual([{ uri: original.uri.toString(), document: original }]);
    expect(coordinator.createBridge.mock.calls[0]?.[1]).toBe(original);
    expect(notebookMocks.createPanel).toHaveBeenCalledWith(
      context,
      coordinatedBridge,
      {
        kind: "notebookVariable",
        label: "sales_tbl",
        variableName: "sales_tbl",
        uri: original.uri.toString()
      },
      "r"
    );
    expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("does not activate Jupyter before workspace trust is granted", async () => {
    const original = notebook("file:///workspace/untrusted-r.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.workspaceTrusted = false;

    await expect(discoverVariablesForSelectedKernel(original)).rejects.toThrow(
      "Trust this workspace before Open Wrangler inspects a notebook kernel."
    );

    expect(notebookMocks.activateJupyter).not.toHaveBeenCalled();
    expect(notebookMocks.getKernel).not.toHaveBeenCalled();
    expect(notebookMocks.executeCode).not.toHaveBeenCalled();
  });

  it("rejects a stale cached R descriptor", async () => {
    const original = notebook("file:///workspace/r-cached-stale.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel());
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator } = register();

    const discovery = await discoverVariablesForSelectedKernel(original);
    if (!isRNotebookVariableDiscovery(discovery)) throw new Error("Expected an R notebook discovery.");
    await openDiscoveredRNotebookVariable(context, coordinator as unknown as SessionCoordinator, original, discovery, {
      ...discovery.variables[0]!,
      name: "renamed_sales_tbl"
    });

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The selected R dataframe no longer belongs to this variable list. Open the picker again."
    );
  });

  it("rejects a cached R descriptor when its dataframe flavor changes", async () => {
    const original = notebook("file:///workspace/r-cached-flavor.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel());
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator } = register();

    const discovery = await discoverVariablesForSelectedKernel(original);
    if (!isRNotebookVariableDiscovery(discovery)) throw new Error("Expected an R notebook discovery.");
    await openDiscoveredRNotebookVariable(context, coordinator as unknown as SessionCoordinator, original, discovery, {
      ...discovery.variables[0]!,
      dataframeFlavor: "r.data.frame"
    });

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The selected R dataframe no longer belongs to this variable list. Open the picker again."
    );
  });

  it("rejects a cached R descriptor after its selected kernel changes", async () => {
    const original = notebook("file:///workspace/r-cached-kernel.ipynb");
    const disposeStatusListener = vi.fn();
    const selectedKernel = rNotebookKernel(disposeStatusListener);
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.getKernel.mockResolvedValue(selectedKernel);
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator } = register();

    const discovery = await discoverVariablesForSelectedKernel(original);
    if (!isRNotebookVariableDiscovery(discovery)) throw new Error("Expected an R notebook discovery.");
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel());
    await openDiscoveredRNotebookVariable(
      context,
      coordinator as unknown as SessionCoordinator,
      original,
      discovery,
      discovery.variables[0]!
    );

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(disposeStatusListener).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The selected R notebook kernel changed while Open Wrangler inspected its variables. Try again."
    );
  });

  it("rejects a cached R descriptor after its exact notebook document closes", async () => {
    const original = notebook("file:///workspace/r-cached-document.ipynb");
    const replacement = notebook("file:///workspace/r-cached-document.ipynb");
    const disposeStatusListener = vi.fn();
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel(disposeStatusListener));
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const { context, coordinator } = register();

    const discovery = await discoverVariablesForSelectedKernel(original);
    if (!isRNotebookVariableDiscovery(discovery)) throw new Error("Expected an R notebook discovery.");
    closeNotebook(original);
    notebookMocks.notebookDocuments.splice(0, 1, replacement);
    await openDiscoveredRNotebookVariable(
      context,
      coordinator as unknown as SessionCoordinator,
      original,
      discovery,
      discovery.variables[0]!
    );

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(disposeStatusListener).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
  });

  it("rechecks the R notebook after returning focus from its picker", async () => {
    const original = notebook("file:///workspace/r-focus.ipynb");
    const replacement = notebook("file:///workspace/r-focus.ipynb");
    const disposeStatusListener = vi.fn();
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel(disposeStatusListener));
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    notebookMocks.restoreEditorGroupAfterQuickPick.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.rVerifiedSelections).toHaveLength(0);
    expect(notebookMocks.rDelegateDisposals).toEqual([]);
    expect(disposeStatusListener).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
  });

  it("disposes the claimed R bridge when panel creation fails", async () => {
    const original = notebook("file:///workspace/r-panel-failure.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.getKernel.mockResolvedValue(rNotebookKernel());
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    const panelError = new Error("panel creation failed");
    notebookMocks.createPanel.mockImplementationOnce(() => {
      throw panelError;
    });
    const { coordinator } = register();

    await expect(command("openWrangler.openNotebookVariable")()).rejects.toBe(panelError);

    expect(coordinator.createBridge).toHaveBeenCalledOnce();
    expect(notebookMocks.rVerifiedSelections).toHaveLength(1);
    expect(notebookMocks.rDelegateDisposals).toEqual([original]);
  });

  it("rejects an R selection when the kernel changes while the picker is open", async () => {
    const original = notebook("file:///workspace/r-kernel-change.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    const originalKernel = rNotebookKernel();
    const replacementKernel = rNotebookKernel();
    notebookMocks.getKernel.mockResolvedValue(originalKernel);
    notebookMocks.executeCode.mockImplementation((code) =>
      rDiscoveryOutputs(code, {
        protocolVersion: 1,
        truncated: false,
        variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
      })
    );
    notebookMocks.showQuickPick.mockImplementationOnce(async (items) => {
      notebookMocks.getKernel.mockResolvedValue(replacementKernel);
      return items[0];
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.rKernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The selected R notebook kernel changed while Open Wrangler inspected its variables. Try again."
    );
  });

  it.each([
    ["name", { name: "renamed_sales_tbl", dataframeFlavor: "r.tibble" }],
    ["flavor", { name: "sales_tbl", dataframeFlavor: "r.data.frame" }]
  ])("rejects an R selection when its %s changes while the picker is open", async (_change, changedVariable) => {
    const original = notebook("file:///workspace/r-variable-change.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    const rKernel = rNotebookKernel();
    notebookMocks.getKernel.mockResolvedValue(rKernel);
    notebookMocks.executeCode
      .mockImplementationOnce((code) =>
        rDiscoveryOutputs(code, {
          protocolVersion: 1,
          truncated: false,
          variables: [{ name: "sales_tbl", dataframeFlavor: "r.tibble" }]
        })
      )
      .mockImplementationOnce((code) =>
        rDiscoveryOutputs(code, {
          protocolVersion: 1,
          truncated: false,
          variables: [changedVariable]
        })
      );
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.executeCode).toHaveBeenCalledTimes(2);
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.rKernelOrigins).toEqual([]);
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The selected R dataframe changed while the picker was open. Open the picker again."
    );
  });

  it("treats picker cancellation as actionless", async () => {
    const original = notebook("file:///workspace/cancelled.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.showQuickPick.mockResolvedValueOnce(undefined);
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.executeCode).toHaveBeenCalledOnce();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.createPanel).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
  });

  it("rejects a malformed discovery response before showing the picker", async () => {
    const original = notebook("file:///workspace/malformed.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.executeCode.mockImplementationOnce((code) => discoveryOutputs(code, '{"protocolVersion":1'));
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler received a malformed notebook variable discovery response."
    );
  });

  it("rejects an oversized discovery response before parsing or showing the picker", async () => {
    const original = notebook("file:///workspace/oversized.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.executeCode.mockImplementationOnce((code) => discoveryOutputs(code, "x".repeat(70 * 1024)));
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler rejected an oversized notebook variable discovery response."
    );
  });

  it.each([
    [
      "malformed output",
      { unexpected: true },
      "Open Wrangler received a malformed notebook variable discovery response."
    ],
    [
      "oversized output",
      {
        items: [
          {
            mime: "application/x.notebook.stream.stdout",
            data: new Uint8Array(64 * 1024 + 1)
          }
        ]
      },
      "Open Wrangler rejected an oversized notebook variable discovery response."
    ],
    [
      "kernel error output",
      {
        items: [
          {
            mime: "application/vnd.code.notebook.error",
            data: Buffer.from(JSON.stringify({ name: "RuntimeError", message: "discovery failed" }), "utf8")
          }
        ]
      },
      "Open Wrangler could not inspect dataframe variables in the selected notebook kernel."
    ]
  ] as const)(
    "drains a dispatched iterator after %s without cancelling or disposing its token",
    async (_kind, failure, message) => {
      const original = notebook(`file:///workspace/discovery-${_kind.replaceAll(" ", "-")}.ipynb`);
      notebookMocks.notebookDocuments.push(original);
      notebookMocks.activeNotebookEditor = editor(original);
      const drainStarted = deferred<void>();
      const releaseDrain = deferred<void>();
      let drainedTail = false;
      notebookMocks.executeCode.mockImplementationOnce((code) => {
        const tail = discoveryOutputs(code);
        return {
          async *[Symbol.asyncIterator]() {
            yield failure;
            drainStarted.resolve();
            await releaseDrain.promise;
            if (_kind === "malformed output") {
              const replacement = notebook(original.uri.toString());
              closeNotebook(original);
              notebookMocks.notebookDocuments.splice(0, 1, replacement);
              notebookMocks.activeNotebookEditor = editor(replacement);
            }
            for await (const output of tail) {
              drainedTail = true;
              yield output;
            }
          }
        } as never;
      });
      const { coordinator } = register();

      const pending = command("openWrangler.openNotebookVariable")();
      await drainStarted.promise;

      expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
      expect(coordinator.createBridge).not.toHaveBeenCalled();
      expect(notebookMocks.tokenSources).toHaveLength(1);
      expect(notebookMocks.tokenSources[0]).toMatchObject({ disposed: false });
      expect(notebookMocks.tokenSources[0]?.token.isCancellationRequested).toBe(false);

      releaseDrain.resolve();
      await pending;

      expect(drainedTail).toBe(true);
      expect(notebookMocks.tokenSources[0]).toMatchObject({ disposed: true });
      expect(notebookMocks.tokenSources[0]?.token.isCancellationRequested).toBe(false);
      expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
      expect(coordinator.createBridge).not.toHaveBeenCalled();
      expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(message);
    }
  );

  it("rejects an excessive zero-byte output stream", async () => {
    const original = notebook("file:///workspace/output-flood.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    let emittedOutputs = 0;
    notebookMocks.executeCode.mockImplementationOnce(() => ({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 132; index += 1) {
          emittedOutputs += 1;
          yield {
            items: [
              {
                mime: "application/x.notebook.stream.stdout",
                data: new Uint8Array()
              }
            ]
          };
        }
      }
    }));
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "Open Wrangler rejected an oversized notebook variable discovery response."
    );
    expect(emittedOutputs).toBe(132);
    expect(notebookMocks.tokenSources[0]).toMatchObject({ disposed: true });
    expect(notebookMocks.tokenSources[0]?.token.isCancellationRequested).toBe(false);
  });

  it("does not request a replacement notebook kernel after Jupyter activation", async () => {
    const original = notebook("file:///workspace/discovery-replaced.ipynb");
    const replacement = notebook("file:///workspace/discovery-replaced.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    notebookMocks.activateJupyter.mockImplementationOnce(async () => {
      closeNotebook(original);
      notebookMocks.notebookDocuments.splice(0, 1, replacement);
      notebookMocks.activeNotebookEditor = editor(replacement);
      return { kernels: { getKernel: notebookMocks.getKernel } };
    });
    const { coordinator } = register();

    await command("openWrangler.openNotebookVariable")();

    expect(notebookMocks.getKernel).not.toHaveBeenCalled();
    expect(notebookMocks.executeCode).not.toHaveBeenCalled();
    expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
  });

  it("discards discovery output produced after the exact notebook is replaced", async () => {
    const original = notebook("file:///workspace/discovery-output-replaced.ipynb");
    const replacement = notebook("file:///workspace/discovery-output-replaced.ipynb");
    notebookMocks.notebookDocuments.push(original);
    notebookMocks.activeNotebookEditor = editor(original);
    const drainStarted = deferred<void>();
    const releaseDrain = deferred<void>();
    let drainedTail = false;
    notebookMocks.executeCode.mockImplementationOnce((code) => {
      const output = discoveryOutputs(code);
      return {
        async *[Symbol.asyncIterator]() {
          const next = await output[Symbol.asyncIterator]().next();
          closeNotebook(original);
          notebookMocks.notebookDocuments.splice(0, 1, replacement);
          notebookMocks.activeNotebookEditor = editor(replacement);
          if (!next.done) yield next.value;
          drainStarted.resolve();
          await releaseDrain.promise;
          drainedTail = true;
          yield { unexpected: true } as never;
        }
      };
    });
    const { coordinator } = register();

    const pending = command("openWrangler.openNotebookVariable")();
    await drainStarted.promise;

    expect(notebookMocks.showWarningMessage).not.toHaveBeenCalled();
    expect(notebookMocks.tokenSources).toHaveLength(1);
    expect(notebookMocks.tokenSources[0]).toMatchObject({ disposed: false });
    expect(notebookMocks.tokenSources[0]?.token.isCancellationRequested).toBe(false);

    releaseDrain.resolve();
    await pending;

    expect(drainedTail).toBe(true);
    expect(notebookMocks.showQuickPick).not.toHaveBeenCalled();
    expect(coordinator.createBridge).not.toHaveBeenCalled();
    expect(notebookMocks.showWarningMessage).toHaveBeenCalledWith(
      "The originating notebook is no longer open. Reopen it and try again."
    );
    const discoveryToken = (
      notebookMocks.executeCode.mock.calls[0] as unknown as [string, { readonly isCancellationRequested: boolean }]
    )[1];
    expect(discoveryToken.isCancellationRequested).toBe(false);
    expect(notebookMocks.tokenSources[0]).toMatchObject({ disposed: true });
  });

  it("discovers types without repr, shape, count, collection, or dataframe imports", () => {
    const code = buildNotebookVariableDiscoveryCode("0123456789abcdef0123456789abcdef");

    expect(code).not.toContain("repr(");
    expect(code).not.toContain(".shape");
    expect(code).not.toContain(".count(");
    expect(code).not.toContain(".collect(");
    expect(code).not.toMatch(/import (pandas|polars|pyspark|duckdb)/);
    expect(code).toContain("if __ow_scanned > 4096:");
  });

  it("builds an isolated PySpark preflight without evaluating dataframe contents", () => {
    const marker = "0123456789abcdef0123456789abcdef";
    const code = buildPySparkNotebookPreflightCode(marker, "spark_frame");

    expect(code).toContain("pyspark");
    expect(code).not.toMatch(/import pyspark/u);
    expect(code).not.toContain(".count(");
    expect(code).not.toContain(".collect(");
    expect(code).not.toContain("getattr(");
    expect(code).toContain("__ow_module.__dict__");
    expect(code).toContain("openwrangler_runtime.notebook");
    expect(code).toContain("resolve_live_result");
    expect(parsePySparkNotebookPreflightOutput(preflightText(marker, true, "4.2.0"), marker)).toEqual({
      isPySpark: true,
      version: "4.2.0"
    });
    expect(parsePySparkNotebookPreflightOutput(preflightText(marker, false, null), marker)).toEqual({
      isPySpark: false,
      version: null
    });

    const pinnedCode = buildPySparkNotebookPreflightCode(marker, "spark_frame", "pyspark");
    expect(pinnedCode.indexOf('__ow_module = __ow_sys.modules.get("pyspark")')).toBeLessThan(
      pinnedCode.indexOf("__ow_user_ns.get")
    );
  });

  it("fails closed on malformed PySpark version-probe envelopes", () => {
    const marker = "0123456789abcdef0123456789abcdef";
    const start = `__OPEN_WRANGLER_PYSPARK_VERSION_START_${marker}__`;
    const end = `__OPEN_WRANGLER_PYSPARK_VERSION_END_${marker}__`;

    expect(() =>
      parsePySparkNotebookPreflightOutput(
        `${start}\n${JSON.stringify({ isPySpark: true, protocolVersion: 1, version: "4.2.0", extra: true })}\n${end}`,
        marker
      )
    ).toThrow("could not verify PySpark in the selected notebook kernel");
    expect(() =>
      parsePySparkNotebookPreflightOutput(
        `${start}\n${JSON.stringify({ isPySpark: true, protocolVersion: 1, version: "4.2.0" })}\n${end}\n${end}`,
        marker
      )
    ).toThrow("could not verify PySpark in the selected notebook kernel");
    expect(() =>
      parsePySparkNotebookPreflightOutput(
        `${start}\n${JSON.stringify({ isPySpark: true, protocolVersion: 1, version: "4.2.0-β" })}\n${end}`,
        marker
      )
    ).toThrow("could not verify PySpark in the selected notebook kernel");
    expect(parsePySparkNotebookPreflightOutput(preflightText(marker, true, `4.2.0+${"a".repeat(58)}`), marker)).toEqual(
      {
        isPySpark: true,
        version: `4.2.0+${"a".repeat(58)}`
      }
    );
    for (const version of [`4.2.0+${"a".repeat(59)}`, "4.2.0\n", "4.2.0\u0000"]) {
      expect(() => parsePySparkNotebookPreflightOutput(preflightText(marker, true, version), marker)).toThrow(
        "could not verify PySpark in the selected notebook kernel"
      );
    }
  });
});
