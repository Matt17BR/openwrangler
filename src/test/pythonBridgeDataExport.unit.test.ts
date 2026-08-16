import { describe, expect, it, vi } from "vitest";
import type { OpenSessionRequest, OpenWranglerRequest, OpenWranglerResponse, SessionSource } from "../shared/protocol";
import { PythonBridge, type PythonBridgeFileOperations } from "../extension/pythonBridge";
import type { AtomicFileTransaction } from "../extension/files/safeFileExport";
import { PythonSessionOwnership, type PythonSessionRuntime } from "../extension/pythonSessionOwnership";

interface TestRuntime extends PythonSessionRuntime {
  readonly key: string;
}

interface PythonBridgeExportHarness {
  disposed: boolean;
  fileOperations: PythonBridgeFileOperations;
  sessionOwnership: PythonSessionOwnership<TestRuntime>;
  requestRuntime(request: OpenWranglerRequest): Promise<OpenWranglerResponse>;
}

describe("PythonBridge data export publication", () => {
  it("sends only the host-reserved target to the runtime and reports the final destination", async () => {
    const source: SessionSource = { kind: "file", label: "source.csv", path: "/workspace/source.csv" };
    const runtime = testRuntime();
    const ownership = confirmedOwnership(runtime, source);
    const transaction = testTransaction();
    const beginTransaction = vi.fn(async () => transaction);
    const requestRuntime = vi.fn(async (request: OpenWranglerRequest): Promise<OpenWranglerResponse> => {
      if (request.kind !== "exportData") throw new Error("Expected an export request.");
      return {
        kind: "dataExported",
        revision: request.revision,
        path: request.path,
        format: request.format,
        shape: { rows: 1, columns: 1 }
      };
    });
    const bridge = testBridge(ownership, beginTransaction, requestRuntime);

    await expect(
      bridge.request({
        kind: "exportData",
        sessionId: "session",
        revision: 0,
        path: "/workspace/cleaned.csv",
        format: "csv"
      })
    ).resolves.toMatchObject({ kind: "dataExported", path: "/workspace/cleaned.csv" });

    expect(beginTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        destination: expect.objectContaining({ fsPath: "/workspace/cleaned.csv" }),
        protectedSources: [expect.objectContaining({ fsPath: "/workspace/source.csv" })]
      })
    );
    expect(requestRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "exportData",
        path: "/workspace/.openwrangler-owned.tmp",
        targetIdentity: { device: "7", inode: "11" }
      }),
      {}
    );
    expect(transaction.commit).toHaveBeenCalledOnce();
    expect(transaction.rollback).not.toHaveBeenCalled();
  });

  it("rolls back instead of publishing when the confirmed session is released during runtime export", async () => {
    const source: SessionSource = { kind: "file", label: "source.csv", path: "/workspace/source.csv" };
    const runtime = testRuntime();
    const ownership = confirmedOwnership(runtime, source);
    const transaction = testTransaction();
    let settle!: (response: OpenWranglerResponse) => void;
    const runtimeResponse = new Promise<OpenWranglerResponse>((resolve) => {
      settle = resolve;
    });
    const requestRuntime = vi.fn(async () => runtimeResponse);
    const bridge = testBridge(
      ownership,
      vi.fn(async () => transaction),
      requestRuntime
    );

    const exporting = bridge.request({
      kind: "exportData",
      sessionId: "session",
      revision: 0,
      path: "/workspace/cleaned.csv",
      format: "csv"
    });
    await vi.waitFor(() => expect(requestRuntime).toHaveBeenCalledOnce());
    ownership.releaseConfirmed("session", runtime);
    settle({
      kind: "dataExported",
      revision: 0,
      path: "/workspace/.openwrangler-owned.tmp",
      format: "csv",
      shape: { rows: 1, columns: 1 }
    });

    await expect(exporting).rejects.toThrow("session closed or changed");
    expect(transaction.commit).not.toHaveBeenCalled();
    expect(transaction.rollback).toHaveBeenCalledOnce();
  });
});

function testBridge(
  sessionOwnership: PythonSessionOwnership<TestRuntime>,
  beginTransaction: NonNullable<PythonBridgeFileOperations["beginTransaction"]>,
  requestRuntime: (request: OpenWranglerRequest, options?: unknown) => Promise<OpenWranglerResponse>
): PythonBridge {
  const bridge = Object.create(PythonBridge.prototype) as PythonBridge;
  Object.assign(bridge as object, {
    disposed: false,
    fileOperations: { beginTransaction },
    sessionOwnership,
    requestRuntime
  } satisfies PythonBridgeExportHarness);
  return bridge;
}

function confirmedOwnership(runtime: TestRuntime, source: SessionSource): PythonSessionOwnership<TestRuntime> {
  const ownership = new PythonSessionOwnership<TestRuntime>(vi.fn());
  const request: OpenSessionRequest = {
    kind: "openSession",
    requestedSessionId: "session",
    source,
    backend: "pandas",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 20
  };
  ownership.reserve(request, runtime, "open");
  ownership.finalizeResponse({ requestId: "open", runtime, request }, {
    kind: "sessionOpened",
    metadata: { sessionId: "session" }
  } as OpenWranglerResponse);
  return ownership;
}

function testRuntime(): TestRuntime {
  return { key: "scope", provisionalSessionIds: new Set(), sessionIds: new Set() };
}

function testTransaction(): AtomicFileTransaction {
  return {
    temporaryPath: "/workspace/.openwrangler-owned.tmp",
    write: vi.fn(async () => undefined),
    prepareExternalWriter: vi.fn(async () => ({
      path: "/workspace/.openwrangler-owned.tmp",
      identity: { dev: 7n, ino: 11n }
    })),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    abandon: vi.fn(async () => undefined)
  };
}
