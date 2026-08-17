import { describe, expect, it, vi } from "vitest";
import type { OpenSessionRequest } from "../shared/protocol";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import type { RKernelBridgeTransport } from "../extension/r/rKernelBridgeTransport";
import {
  createRKernelBridge as createBridge,
  deferred,
  fakeAtomicTransaction,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelDocumentOpenRequest as documentOpenRequest,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelRenameContract as renameContract,
  rKernelRenameDiff as renameDiff,
  rKernelRenamePreviewRequest as renamePreviewRequest
} from "./rKernelBridgeTestFixtures";

describe("R kernel data export", () => {
  it("exports the committed result of an editing R document through an extension-owned atomic CSV transaction", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value,count\n"));
      await args[3](new TextEncoder().encode("12.5,9223372036854775807\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });

    await expect(bridge.request(documentOpenRequest("editing"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: false } }
    });
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/rejected.csv",
        format: "csv",
        rowAxisPolicy: "preserve"
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(beginTransaction).not.toHaveBeenCalled();
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.csv",
        format: "csv"
      })
    ).resolves.toEqual({
      kind: "dataExported",
      revision: 0,
      path: "/workspace/orders.cleaned.csv",
      format: "csv",
      shape: { rows: 1, columns: 8 }
    });

    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.cleaned.csv" }),
      protectedSources: [expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.R" })]
    });
    expect(exportData).toHaveBeenCalledWith(
      sessionId,
      0,
      "csv",
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30 * 60_000 })
    );
    expect(atomic.write).toHaveBeenNthCalledWith(1, new TextEncoder().encode("value,count\n"));
    expect(atomic.write).toHaveBeenNthCalledWith(2, new TextEncoder().encode("12.5,9223372036854775807\n"));
    expect(atomic.prepareExternalWriter).not.toHaveBeenCalled();
    expect(atomic.commit).toHaveBeenCalledOnce();
    expect(atomic.rollback).not.toHaveBeenCalled();
    expect(atomic.abandon).not.toHaveBeenCalled();
  });

  it("exports an active R-session dataframe without inventing a protected source file", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value,count\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    const request: OpenSessionRequest = {
      ...openRequest("editing"),
      source: { kind: "rInteractiveVariable", label: "orders", variableName: "orders" }
    };

    const opened = await bridge.request(request);
    expect(opened).toMatchObject({
      kind: "sessionOpened",
      metadata: {
        source: request.source,
        capabilities: { exportCsv: true, notebookInsert: false }
      }
    });
    if (opened.kind !== "sessionOpened") throw new Error("Expected an active R session.");
    expect(opened.metadata.capabilities.documentInsert).not.toBe(true);
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/workspace/orders.cleaned.csv", format: "csv" });

    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.cleaned.csv" }),
      protectedSources: []
    });
  });

  it("advertises and atomically exports Parquet only when the selected R runtime supports it", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("PAR1native-r-parquetPAR1"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "parquet",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = {
      ...fakeTransport(contract, sessionId, ["csv", "parquet"]),
      exportData
    };
    const atomic = fakeAtomicTransaction();
    const beginTransaction = vi.fn(async () => atomic.transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });

    await expect(bridge.request(documentOpenRequest("editing"))).resolves.toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: true } }
    });
    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/orders.cleaned.parquet",
        format: "parquet"
      })
    ).resolves.toEqual({
      kind: "dataExported",
      revision: 0,
      path: "/workspace/orders.cleaned.parquet",
      format: "parquet",
      shape: { rows: 1, columns: 8 }
    });

    expect(exportData).toHaveBeenCalledWith(
      sessionId,
      0,
      "parquet",
      expect.any(Function),
      expect.objectContaining({ timeoutMs: 30 * 60_000 })
    );
    expect(atomic.write).toHaveBeenCalledWith(new TextEncoder().encode("PAR1native-r-parquetPAR1"));
    expect(atomic.commit).toHaveBeenCalledOnce();
    expect(atomic.rollback).not.toHaveBeenCalled();
  });

  it("advertises R export formats only for eligible local notebook and document sessions", async () => {
    const contract = frameContract();
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async (...args) => {
      await args[3](new TextEncoder().encode("value\n12.5\n"));
      return {
        sessionId: args[0],
        revision: args[1],
        format: "csv",
        rows: contract.shape.rows,
        columns: contract.shape.columns
      };
    });
    const transport = { ...fakeTransport(contract), exportData };
    const beginTransaction = vi.fn(async () => fakeAtomicTransaction().transaction);

    const viewingBridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    const viewing = await viewingBridge.request(documentOpenRequest("viewing"));
    expect(viewing).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });
    await expect(
      viewingBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "unsupported_mode" });

    const notebookTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const notebookBridge = createBridge(notebookTransport, undefined, undefined, undefined, { beginTransaction });
    const notebook = await notebookBridge.request(openRequest("editing"));
    expect(notebook).toMatchObject({
      kind: "sessionOpened",
      metadata: { capabilities: { exportCsv: true, exportParquet: false } }
    });
    await expect(
      notebookBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.parquet",
        format: "parquet"
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "unsupported_operation",
      message: expect.stringContaining("nanoparquet 0.5.1")
    });
    await expect(
      notebookBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/workspace/out.csv", format: "csv" });

    const untitledTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const untitledBridge = createBridge(untitledTransport, undefined, undefined, undefined, { beginTransaction });
    const untitled = await untitledBridge.request(documentOpenRequest("editing", "untitled:orders.R"));
    expect(untitled).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });
    await expect(
      untitledBridge.request({
        kind: "exportData",
        sessionId,
        revision: 0,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "unsupported_operation" });

    const remoteTransport = { ...fakeTransport(contract), exportData: vi.fn(exportData) };
    const remoteBridge = createBridge(remoteTransport, undefined, undefined, undefined, { beginTransaction });
    const remote = await remoteBridge.request(
      documentOpenRequest("editing", "vscode-remote://ssh-remote+host/workspace/orders.R")
    );
    expect(remote).toMatchObject({ kind: "sessionOpened", metadata: { capabilities: { exportCsv: false } } });

    expect(beginTransaction).toHaveBeenCalledOnce();
    expect(beginTransaction).toHaveBeenCalledWith({
      destination: expect.objectContaining({ scheme: "file", fsPath: "/workspace/out.csv" }),
      protectedSources: [expect.objectContaining({ scheme: "file", fsPath: "/workspace/orders.ipynb" })]
    });
  });

  it("rolls back the host transaction immediately when the private R export detaches", async () => {
    const contract = frameContract();
    const lateWriter = deferred<void>();
    const transport = {
      ...fakeTransport(contract),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => {
        throw new DetachedBridgeRequestError("R export is still settling.", "timeout", true, lateWriter.promise);
      })
    };
    const atomic = fakeAtomicTransaction();
    const diagnostics = vi.fn();
    const bridge = createBridge(transport, undefined, diagnostics, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const exportRequest = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await expect(exportRequest).rejects.toBeInstanceOf(DetachedBridgeRequestError);
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.abandon).not.toHaveBeenCalled();

    lateWriter.resolve();
    await Promise.resolve();
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("rolls back instead of publishing when the R runtime generation changes during export", async () => {
    const contract = frameContract();
    const lateResult = deferred<{
      sessionId: string;
      revision: number;
      format: "csv";
      rows: number;
      columns: number;
    }>();
    const transport = {
      ...fakeTransport(contract),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => lateResult.promise)
    };
    const atomic = fakeAtomicTransaction();
    const bridge = createBridge(transport, undefined, undefined, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const pending = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await vi.waitFor(() => expect(transport.exportData).toHaveBeenCalledOnce());
    transport.invalidate();
    lateResult.resolve({
      sessionId,
      revision: 0,
      format: "csv",
      rows: 1,
      columns: 8
    });

    await expect(pending).resolves.toMatchObject({ kind: "error", code: "r_kernel_changed" });
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.commit).not.toHaveBeenCalled();
  });

  it("rolls back an R export whose pinned revision changes before the writer returns", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const lateResult = deferred<{
      sessionId: string;
      revision: number;
      format: "csv";
      rows: number;
      columns: number;
    }>();
    const transport = {
      ...fakeTransport(source),
      exportData: vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(async () => lateResult.promise)
    };
    const atomic = fakeAtomicTransaction();
    const bridge = createBridge(transport, undefined, undefined, undefined, {
      beginTransaction: vi.fn(async () => atomic.transaction)
    });
    await bridge.request(documentOpenRequest("editing"));

    const pending = bridge.request({
      kind: "exportData",
      sessionId,
      revision: 0,
      path: "/workspace/out.csv",
      format: "csv"
    });
    await vi.waitFor(() => expect(transport.exportData).toHaveBeenCalledOnce());
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await expect(bridge.request(renamePreviewRequest(0))).resolves.toMatchObject({ kind: "stepPreview", revision: 1 });
    lateResult.resolve({
      sessionId,
      revision: 0,
      format: "csv",
      rows: 1,
      columns: 8
    });

    await expect(pending).resolves.toMatchObject({ kind: "error", code: "stale_response" });
    expect(atomic.rollback).toHaveBeenCalledOnce();
    expect(atomic.commit).not.toHaveBeenCalled();
  });

  it("does not reserve an R export file while a draft is open", async () => {
    const source = frameContract();
    const renamed = renameContract(source, "r:c:0", "amount");
    const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>();
    const transport = { ...fakeTransport(source), exportData };
    const beginTransaction = vi.fn(async () => fakeAtomicTransaction().transaction);
    const bridge = createBridge(transport, undefined, undefined, undefined, { beginTransaction });
    await bridge.request(documentOpenRequest("editing"));
    transport.queuePreview({
      sessionId,
      revision: 1,
      page: renamed,
      diff: renameDiff(),
      code: "open_wrangler_result <- orders"
    });
    await bridge.request(renamePreviewRequest(0));

    await expect(
      bridge.request({
        kind: "exportData",
        sessionId,
        revision: 1,
        path: "/workspace/out.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "error", code: "invalid_request" });
    expect(beginTransaction).not.toHaveBeenCalled();
    expect(exportData).not.toHaveBeenCalled();
  });
});
