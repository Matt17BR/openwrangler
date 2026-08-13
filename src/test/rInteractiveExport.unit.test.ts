import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { OpenSessionRequest } from "../shared/protocol";
import type { AtomicFileTransaction } from "../extension/files/safeFileExport";
import { RKernelBridge, type RKernelBridgeTransport } from "../extension/r/rKernelBridge";
import type { RFramePageContract } from "../extension/r/rFrameContract";

const sessionId = "91919191-9191-4191-8191-919191919191";

describe("active R-terminal cleaned-data export", () => {
  it("atomically exports the exact live dataframe as CSV and Parquet without inventing a source file", async () => {
    const contract = activeFrameContract();
    const transport = activeExportTransport(contract);
    const transactions: TransactionReceipt[] = [];
    const beginTransaction = vi.fn(async (options: Parameters<NonNullable<AtomicBegin>>[0]) => {
      const receipt = transactionReceipt(transactions.length, options);
      transactions.push(receipt);
      return receipt.transaction;
    });
    const context = {
      extension: { packageJSON: { version: "2.0.0-preview.1" } },
      subscriptions: []
    } as unknown as vscode.ExtensionContext;
    const bridge = new RKernelBridge(
      context,
      transport,
      () => sessionId,
      undefined,
      { name: "base_orders", backend: "r", dataframeFlavor: "r.data.frame" },
      { beginTransaction }
    );
    const source = Object.freeze({
      kind: "rInteractiveVariable" as const,
      label: "base_orders",
      variableName: "base_orders"
    });
    const open: OpenSessionRequest = {
      kind: "openSession",
      source,
      requestedSessionId: sessionId,
      backend: "r",
      mode: "editing",
      pageSize: 20,
      columnOffset: 0,
      columnLimit: 1
    };

    try {
      await expect(bridge.request(open)).resolves.toMatchObject({
        kind: "sessionOpened",
        metadata: {
          sessionId,
          source,
          mode: "editing",
          capabilities: {
            exportCsv: true,
            exportParquet: true,
            notebookInsert: false
          }
        }
      });

      for (const [format, destination] of [
        ["csv", "/workspace/base-orders.cleaned.csv"],
        ["parquet", "/workspace/base-orders.cleaned.parquet"]
      ] as const) {
        await expect(
          bridge.request({ kind: "exportData", sessionId, revision: 0, path: destination, format })
        ).resolves.toEqual({
          kind: "dataExported",
          revision: 0,
          path: destination,
          format,
          shape: { rows: 2, columns: 1 }
        });
      }

      expect(beginTransaction).toHaveBeenCalledTimes(2);
      for (const [index, destination] of [
        "/workspace/base-orders.cleaned.csv",
        "/workspace/base-orders.cleaned.parquet"
      ].entries()) {
        expect(beginTransaction).toHaveBeenNthCalledWith(index + 1, {
          destination: expect.objectContaining({ scheme: "file", fsPath: destination }),
          protectedSources: []
        });
        expect(transactions[index]?.commit).toHaveBeenCalledOnce();
        expect(transactions[index]?.rollback).not.toHaveBeenCalled();
        expect(transactions[index]?.abandon).not.toHaveBeenCalled();
      }
      expect(Buffer.concat(transactions[0]?.chunks.map((chunk) => Buffer.from(chunk)) ?? []).toString("utf8")).toBe(
        "order_id\n3400001\n3400002\n"
      );
      expect(Buffer.concat(transactions[1]?.chunks.map((chunk) => Buffer.from(chunk)) ?? []).toString("utf8")).toBe(
        "PAR1active-r-terminalPAR1"
      );
      expect(transport.exportData).toHaveBeenNthCalledWith(
        1,
        sessionId,
        0,
        "csv",
        expect.any(Function),
        expect.objectContaining({ timeoutMs: 30 * 60_000 })
      );
      expect(transport.exportData).toHaveBeenNthCalledWith(
        2,
        sessionId,
        0,
        "parquet",
        expect.any(Function),
        expect.objectContaining({ timeoutMs: 30 * 60_000 })
      );
      expect(source).toEqual({
        kind: "rInteractiveVariable",
        label: "base_orders",
        variableName: "base_orders"
      });
    } finally {
      await bridge.dispose();
    }
  });
});

type AtomicBegin = NonNullable<NonNullable<ConstructorParameters<typeof RKernelBridge>[5]>["beginTransaction"]>;

interface TransactionReceipt {
  readonly transaction: AtomicFileTransaction;
  readonly chunks: Uint8Array[];
  readonly commit: ReturnType<typeof vi.fn>;
  readonly rollback: ReturnType<typeof vi.fn>;
  readonly abandon: ReturnType<typeof vi.fn>;
}

function transactionReceipt(index: number, _options: Parameters<AtomicBegin>[0]): TransactionReceipt {
  const chunks: Uint8Array[] = [];
  const commit = vi.fn(async () => undefined);
  const rollback = vi.fn(async () => undefined);
  const abandon = vi.fn(async () => undefined);
  return {
    transaction: {
      temporaryPath: `/workspace/.openwrangler-r-interactive-export-${index}.tmp`,
      write: vi.fn(async (chunk: Uint8Array) => {
        chunks.push(Uint8Array.from(chunk));
      }),
      prepareExternalWriter: vi.fn(async () => ({
        path: `/workspace/.openwrangler-r-interactive-export-${index}.tmp`,
        identity: { dev: 401n, ino: BigInt(500 + index) }
      })),
      commit,
      rollback,
      abandon
    },
    chunks,
    commit,
    rollback,
    abandon
  };
}

function activeExportTransport(contract: RFramePageContract): RKernelBridgeTransport & {
  exportData: ReturnType<typeof vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>>;
} {
  const emitter = new vscode.EventEmitter<void>();
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected active R-terminal transport request.");
  };
  const exportData = vi.fn<NonNullable<RKernelBridgeTransport["exportData"]>>(
    async (openedSessionId, revision, format, writeChunk) => {
      const bytes =
        format === "csv"
          ? new TextEncoder().encode("order_id\n3400001\n3400002\n")
          : new TextEncoder().encode("PAR1active-r-terminalPAR1");
      await writeChunk(bytes.subarray(0, 8));
      await writeChunk(bytes.subarray(8));
      return { sessionId: openedSessionId, revision, format, rows: 2, columns: 1 };
    }
  );
  return {
    onDidInvalidateKernel: emitter.event,
    open: vi.fn(async () => ({ sessionId, page: contract, exportFormats: ["csv", "parquet"] as const })),
    getPage: vi.fn(async () => contract),
    getSummary: vi.fn(async () => []),
    getDatasetStats: vi.fn(async () => ({
      totalRows: 2,
      stats: {
        missingCells: 0,
        missingRows: 0,
        duplicateRows: 0,
        missingValuesByColumn: [{ column: "order_id", count: 0 }]
      }
    })),
    getColumnValues: vi.fn(async () => ({ column: "order_id", values: [], hasMore: false })),
    previewStep: vi.fn(unexpected),
    applyDraft: vi.fn(unexpected),
    discardDraft: vi.fn(unexpected),
    undoStep: vi.fn(unexpected),
    inspectStep: vi.fn(unexpected),
    exportData,
    close: vi.fn(async () => undefined),
    isSessionMapped: vi.fn(() => true),
    dispose: vi.fn(async () => undefined)
  };
}

function activeFrameContract(): RFramePageContract {
  const schema = Object.freeze([
    Object.freeze({
      id: "r:c:0",
      name: "order_id",
      position: 0,
      rawType: "integer",
      type: "integer" as const,
      nullable: false,
      semantics: Object.freeze({ kind: "integer" as const, storageMode: "integer" as const, classes: ["integer"] })
    })
  ]);
  return {
    contractVersion: 5,
    dataframeFlavor: "r.data.frame",
    shape: { rows: 2, columns: 1 },
    frameSemantics: { classes: ["data.frame"], rowNames: "positional", keyColumnIds: [] },
    schema,
    page: {
      offset: 0,
      limit: 20,
      totalRows: 2,
      columnOffset: 0,
      columnLimit: 1,
      columnIds: ["r:c:0"],
      rows: [
        {
          id: "r:r:0",
          rowNumber: 0,
          values: [{ kind: "integer", raw: "3400001", display: "3400001", isNull: false, isNaN: false }]
        },
        {
          id: "r:r:1",
          rowNumber: 1,
          values: [{ kind: "integer", raw: "3400002", display: "3400002", isNull: false, isNaN: false }]
        }
      ]
    }
  };
}
