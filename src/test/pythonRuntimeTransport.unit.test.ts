import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope
} from "../shared/protocol";
import type { CancellationTokenLike } from "../extension/dataBridge";
import { PythonRuntimeTransport, type PythonRuntimeTransportSlot } from "../extension/pythonRuntimeTransport";
import { PythonSessionOwnership } from "../extension/pythonSessionOwnership";

const initializeRequest: OpenWranglerRequest = { kind: "initialize" };
const initializedResponse: OpenWranglerResponse = {
  kind: "initialized",
  protocolVersion: 2,
  runtimeVersion: "test-runtime",
  capabilities: {
    editable: true,
    lazy: true,
    cancel: false,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: true
  }
};

class ManualCancellation implements CancellationTokenLike {
  private listener: (() => void) | undefined;
  readonly dispose = vi.fn();
  isCancellationRequested = false;

  onCancellationRequested(listener: () => void): { dispose(): void } {
    this.listener = listener;
    return { dispose: this.dispose };
  }

  cancel(): void {
    this.isCancellationRequested = true;
    this.listener?.();
  }
}

interface TransportHarness {
  readonly transport: PythonRuntimeTransport<PythonRuntimeTransportSlot>;
  readonly runtime: PythonRuntimeTransportSlot;
  readonly restartRuntime: ReturnType<typeof vi.fn>;
  readonly releasePendingForRequest: ReturnType<typeof vi.fn>;
  readonly stopRuntimeIfIdle: ReturnType<typeof vi.fn>;
  readonly diagnostics: string[];
  writes(): RuntimeRequestEnvelope[];
  respond(requestId: string, response: OpenWranglerResponse): void;
  respondRaw(value: unknown): void;
}

function createHarness(): TransportHarness {
  const rawWrites: string[] = [];
  const process = {
    stdin: {
      destroyed: false,
      writable: true,
      write: vi.fn((value: string, callback?: (error?: Error | null) => void) => {
        rawWrites.push(value);
        callback?.();
        return true;
      })
    }
  } as unknown as ChildProcessWithoutNullStreams;
  const runtime: PythonRuntimeTransportSlot = {
    key: "test-scope",
    pendingIds: new Set(),
    provisionalSessionIds: new Set(),
    sessionIds: new Set(),
    process,
    processStart: undefined,
    runtimeExitError: undefined
  };
  const restartRuntime = vi.fn();
  const stopRuntimeIfIdle = vi.fn();
  const diagnostics: string[] = [];
  const sessionOwnership = new PythonSessionOwnership<PythonRuntimeTransportSlot>(restartRuntime);
  const releasePendingForRequest = vi.spyOn(sessionOwnership, "releasePendingForRequest");
  const transport = new PythonRuntimeTransport<PythonRuntimeTransportSlot>({
    sessionOwnership,
    restartRuntime,
    stopRuntimeIfIdle,
    runtimeUnavailableError: vi.fn((_runtime, error) =>
      error instanceof Error ? error : new Error("The Python runtime is unavailable.")
    ),
    reportDiagnostic: (message) => diagnostics.push(message)
  });
  const respondRaw = (value: unknown): void => transport.handleLine(runtime, process, JSON.stringify(value));
  return {
    transport,
    runtime,
    restartRuntime,
    releasePendingForRequest,
    stopRuntimeIfIdle,
    diagnostics,
    writes: () => rawWrites.map((line) => JSON.parse(line) as RuntimeRequestEnvelope),
    respond: (requestId, response) =>
      respondRaw({ protocolVersion: 2, requestId, response } satisfies RuntimeResponseEnvelope),
    respondRaw
  };
}

describe("PythonRuntimeTransport", () => {
  it.each([
    {
      name: "the runtime cannot cancel running work",
      acknowledgement: {
        kind: "error" as const,
        code: "cancellation_unavailable",
        message: "The request is already running.",
        recoverable: true
      }
    },
    {
      name: "the runtime accepts cancellation of queued work",
      acknowledgement: { kind: "cancelled" as const, targetRequestId: "original" }
    }
  ])("waits for the original correlated response when $name", async ({ acknowledgement }) => {
    const token = new ManualCancellation();
    const harness = createHarness();
    const response = harness.transport.dispatch(
      harness.runtime,
      harness.runtime.process!,
      initializeRequest,
      {
        cancellation: token,
        timeoutMs: 5_000
      },
      vi.fn()
    );
    const original = harness.writes()[0]!;

    token.cancel();
    const cancellation = harness.writes()[1]!;
    expect(cancellation.request).toEqual({ kind: "cancelRequest", targetRequestId: original.requestId });
    harness.respond(
      cancellation.requestId,
      acknowledgement.kind === "cancelled"
        ? { ...acknowledgement, targetRequestId: original.requestId }
        : acknowledgement
    );

    let settled = false;
    void response.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(harness.runtime.pendingIds.size).toBe(1);

    const authoritative =
      acknowledgement.kind === "cancelled"
        ? ({ kind: "cancelled", targetRequestId: original.requestId } as const)
        : initializedResponse;
    harness.respond(original.requestId, authoritative);
    await expect(response).resolves.toEqual(authoritative);
    expect(token.dispose).toHaveBeenCalledOnce();
    expect(harness.runtime.pendingIds.size).toBe(0);
  });

  it("handles synchronous cancellation subscription without dispatching or leaking the listener", async () => {
    const dispose = vi.fn();
    const cancellation: CancellationTokenLike = {
      isCancellationRequested: false,
      onCancellationRequested: (listener) => {
        listener();
        return { dispose };
      }
    };
    const harness = createHarness();

    await expect(
      harness.transport.dispatch(
        harness.runtime,
        harness.runtime.process!,
        initializeRequest,
        {
          cancellation,
          timeoutMs: 5_000
        },
        vi.fn()
      )
    ).resolves.toEqual({ kind: "cancelled", targetRequestId: "not-started" });
    expect(harness.writes()).toEqual([]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(harness.runtime.pendingIds.size).toBe(0);
  });

  it("ignores a malformed correlated response until a valid response arrives", async () => {
    const harness = createHarness();
    const response = harness.transport.dispatch(
      harness.runtime,
      harness.runtime.process!,
      initializeRequest,
      { timeoutMs: 5_000 },
      vi.fn()
    );
    const requestId = harness.writes()[0]!.requestId;

    harness.respondRaw({ protocolVersion: 2, requestId, response: { kind: "initialized" } });
    expect(harness.runtime.pendingIds.size).toBe(1);
    expect(harness.diagnostics).toContainEqual(expect.stringContaining("Invalid runtime response"));

    harness.respond(requestId, initializedResponse);
    await expect(response).resolves.toEqual(initializedResponse);
  });

  it("releases ownership without restarting when a caller disables restart on timeout", async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const response = harness.transport.dispatch(
        harness.runtime,
        harness.runtime.process!,
        initializeRequest,
        { timeoutMs: 10, restartRuntimeOnTimeout: false },
        vi.fn()
      );

      const rejection = expect(response).rejects.toThrow("timed out after 10 ms");
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(harness.restartRuntime).not.toHaveBeenCalled();
      expect(harness.releasePendingForRequest).toHaveBeenCalledOnce();
      expect(harness.stopRuntimeIfIdle).toHaveBeenCalledOnce();
      expect(harness.runtime.pendingIds.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
