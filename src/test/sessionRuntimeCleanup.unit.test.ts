import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import {
  DetachedBridgeRequestError,
  type BridgeRequestOptions,
  type OpenWranglerBridge
} from "../extension/dataBridge";
import {
  SessionRuntimeCleanup,
  runtimeCleanupOptions,
  type RuntimeCleanupTarget
} from "../extension/sessionRuntimeCleanup";

describe("SessionRuntimeCleanup", () => {
  it("closes a terminal runtime once with caller timing and non-restarting safety options", async () => {
    const requests: Array<{ request: OpenWranglerRequest; options?: BridgeRequestOptions }> = [];
    const delegate = bridge(async (request, options) => {
      requests.push({ request, options });
      return { kind: "sessionClosed", sessionId: "runtime" };
    });
    const cleanup = new SessionRuntimeCleanup(() => true);

    await expect(
      cleanup.closeTerminal(target(delegate), { timeoutMs: 37, restartRuntimeOnTimeout: true })
    ).resolves.toEqual({ kind: "sessionClosed", sessionId: "runtime" });

    expect(requests).toEqual([
      {
        request: { kind: "closeSession", sessionId: "runtime", revision: 4 },
        options: {
          priority: "interactive",
          timeoutMs: 37,
          restartRuntimeOnTimeout: false,
          startRuntimeIfNeeded: false
        }
      }
    ]);
  });

  it("retries a non-authoritative terminal response once with fresh bounded options", async () => {
    const reportDiagnostic = vi.fn();
    const calls: Array<BridgeRequestOptions | undefined> = [];
    const delegate = bridge(async (_request, options) => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          kind: "error",
          code: "session_cleanup_failed",
          message: "malformed recoverable cleanup failure",
          recoverable: true,
          sessionId: "runtime"
        };
      }
      return { kind: "sessionClosed", sessionId: "runtime" };
    }, reportDiagnostic);
    const cleanup = new SessionRuntimeCleanup(() => true);

    await expect(cleanup.closeTerminal(target(delegate), { timeoutMs: 19 })).resolves.toMatchObject({
      kind: "error",
      code: "session_cleanup_failed",
      recoverable: true
    });

    expect(calls).toEqual([
      {
        priority: "interactive",
        timeoutMs: 19,
        restartRuntimeOnTimeout: false,
        startRuntimeIfNeeded: false
      },
      runtimeCleanupOptions()
    ]);
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(expect.stringContaining("initial close was not authoritative"));
  });

  it("does not repeat an authoritative terminal cleanup failure", async () => {
    const reportDiagnostic = vi.fn();
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => ({
      kind: "error",
      code: "session_cleanup_failed",
      message: "owned frame cleanup failed",
      recoverable: false,
      sessionId: "runtime"
    }));
    const cleanup = new SessionRuntimeCleanup(() => true);

    await expect(cleanup.closeTerminal(target({ request, reportDiagnostic }))).resolves.toMatchObject({
      kind: "error",
      code: "session_cleanup_failed",
      recoverable: false
    });
    expect(request).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(expect.stringContaining("cleanup completed with an error"));
  });

  it("leaves an exact detached kernel close observed instead of issuing a competing close", async () => {
    const reportDiagnostic = vi.fn();
    const detached = new DetachedBridgeRequestError("host deadline", "timeout", true, Promise.resolve());
    const request = vi.fn(async (): Promise<OpenWranglerResponse> => {
      throw detached;
    });
    const cleanup = new SessionRuntimeCleanup(() => true);

    await expect(cleanup.closeTerminal(target({ request, reportDiagnostic }))).rejects.toBe(detached);
    expect(request).toHaveBeenCalledOnce();
    expect(reportDiagnostic).toHaveBeenCalledWith(expect.stringContaining("exact-kernel close remains observed"));
  });

  it("accepts only an exactly correlated absent-session response for candidate cleanup", async () => {
    const diagnostics = vi.fn();
    const exact = bridge(
      async () => ({
        kind: "error",
        code: "unknown_session",
        message: "Unknown session: runtime",
        recoverable: true,
        sessionId: "runtime"
      }),
      diagnostics
    );
    const mismatched = bridge(
      async () => ({
        kind: "error",
        code: "unknown_session",
        message: "Unknown session: other",
        recoverable: true,
        sessionId: "other"
      }),
      diagnostics
    );
    const cleanup = new SessionRuntimeCleanup(() => true);

    await cleanup.close(target(exact), "import candidate", runtimeCleanupOptions(), true);
    expect(diagnostics).not.toHaveBeenCalled();
    await cleanup.close(target(mismatched), "import candidate", runtimeCleanupOptions(), true);
    expect(diagnostics).toHaveBeenCalledWith(expect.stringMatching(/import candidate.*unknown_session/));
  });

  it("drains every detached cleanup before publishing delegate idle", async () => {
    const first = deferred<OpenWranglerResponse>();
    const second = deferred<OpenWranglerResponse>();
    const responses = [first, second];
    const onIdle = vi.fn();
    const delegate = bridge(async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected extra cleanup.");
      return response.promise;
    });
    delegate.onIdle = onIdle;
    let active = true;
    const cleanup = new SessionRuntimeCleanup(() => active);

    cleanup.track(target(delegate, "old-1"), "retired runtime");
    cleanup.track(target(delegate, "old-2"), "retired runtime");
    let drained = false;
    void cleanup.waitForTracked().then(() => {
      drained = true;
    });
    active = false;
    first.resolve({ kind: "sessionClosed", sessionId: "old-1" });
    await vi.waitFor(() => expect(onIdle).not.toHaveBeenCalled());
    expect(drained).toBe(false);
    second.resolve({ kind: "sessionClosed", sessionId: "old-2" });
    await vi.waitFor(() => expect(drained).toBe(true));
    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("falls back to the coordinator diagnostic sink and contains diagnostic errors", async () => {
    const sink = vi.fn(() => {
      throw new Error("diagnostic sink failed");
    });
    const delegate = bridge(
      async () => ({ kind: "cancelled", targetRequestId: "cleanup" }),
      vi.fn(() => {
        throw new Error("delegate diagnostic failed");
      })
    );
    const cleanup = new SessionRuntimeCleanup(() => true, sink);

    await expect(cleanup.close(target(delegate), "recovery candidate")).resolves.toBeUndefined();
    expect(sink).toHaveBeenCalledOnce();
  });
});

function bridge(
  request: OpenWranglerBridge["request"],
  reportDiagnostic?: (message: string) => void
): OpenWranglerBridge {
  return { request, ...(reportDiagnostic ? { reportDiagnostic } : {}) };
}

function target(delegate: OpenWranglerBridge, runtimeId = "runtime"): RuntimeCleanupTarget {
  return { runtimeId, runtimeRevision: 4, delegate };
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
