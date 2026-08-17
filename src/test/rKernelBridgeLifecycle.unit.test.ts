import { describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError } from "../extension/dataBridge";
import {
  createRKernelBridge as createBridge,
  deferred,
  fakeRKernelTransport as fakeTransport,
  rKernelBridgeSessionId as sessionId,
  rKernelFrameContract as frameContract,
  rKernelOpenRequest as openRequest,
  rKernelRenamePreviewRequest as renamePreviewRequest
} from "./rKernelBridgeTestFixtures";

describe("R kernel bridge lifecycle", () => {
  it("does not migrate a restart-invalidated session and performs terminal cleanup once", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());

    transport.isSessionMapped.mockReturnValue(false);
    transport.invalidate();
    await expect(
      bridge.request({
        kind: "getPage",
        sessionId,
        revision: 0,
        viewRequestId: "after-restart",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 8,
        filterModel: { filters: [], sort: [] }
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId,
      viewRequestId: "after-restart"
    });
    expect(transport.getPage).not.toHaveBeenCalled();

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(Promise.all([bridge.request(close), bridge.request(close)])).resolves.toEqual([
      { kind: "sessionClosed", sessionId },
      { kind: "sessionClosed", sessionId }
    ]);
    expect(transport.close).not.toHaveBeenCalled();

    bridge.onIdle();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
    await Promise.all([bridge.dispose(), bridge.dispose()]);
    expect(transport.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "cancellation"] as const)(
    "closes the mapped R session after a detached %s mutation settles",
    async (reason) => {
      const source = frameContract();
      const transport = fakeTransport(source);
      const bridge = createBridge(transport);
      await bridge.request(openRequest("editing"));
      const lateMutation = deferred<void>();
      transport.previewStep.mockRejectedValueOnce(
        new DetachedBridgeRequestError(`R mutation detached after ${reason}.`, reason, true, lateMutation.promise)
      );

      await expect(bridge.request(renamePreviewRequest(0))).rejects.toMatchObject({
        name: "DetachedBridgeRequestError",
        reason,
        dispatched: true
      });
      await expect(
        bridge.request({
          kind: "getPage",
          sessionId,
          revision: 0,
          viewRequestId: `after-detached-${reason}`,
          offset: 0,
          limit: 20,
          columnOffset: 0,
          columnLimit: 8,
          filterModel: { filters: [], sort: [] }
        })
      ).resolves.toMatchObject({ kind: "error", code: "r_kernel_changed" });

      lateMutation.resolve();
      await lateMutation.promise;
      const close = { kind: "closeSession", sessionId, revision: 0 } as const;
      await expect(bridge.request(close)).resolves.toEqual({ kind: "sessionClosed", sessionId });
      expect(transport.close).toHaveBeenCalledTimes(1);
      expect(transport.close).toHaveBeenCalledWith(sessionId, {
        timeoutMs: undefined,
        cancellation: undefined
      });
    }
  );

  it("dispatches at most one close for concurrent requests", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    let releaseClose: (() => void) | undefined;
    transport.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        })
    );

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    const first = bridge.request(close);
    const second = bridge.request(close);
    await vi.waitFor(() => expect(transport.close).toHaveBeenCalledTimes(1));
    bridge.onIdle();
    expect(transport.dispose).not.toHaveBeenCalled();
    releaseClose?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: "sessionClosed", sessionId },
      { kind: "sessionClosed", sessionId }
    ]);
    expect(transport.close).toHaveBeenCalledTimes(1);
    bridge.onIdle();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
  });

  it("keeps an unconfirmed close retryable instead of synthesizing success", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    transport.close.mockRejectedValueOnce(new Error("close transport failed"));

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(bridge.request(close)).rejects.toThrow("close transport failed");
    await expect(bridge.request(close)).resolves.toEqual({ kind: "sessionClosed", sessionId });

    expect(transport.close).toHaveBeenCalledTimes(2);
  });

  it("releases an idle bridge only after a detached close is authoritatively retired", async () => {
    const transport = fakeTransport(frameContract());
    const bridge = createBridge(transport);
    await bridge.request(openRequest());
    const lateClose = deferred<void>();
    let mapped = true;
    transport.isSessionMapped.mockImplementation(() => mapped);
    transport.close.mockRejectedValueOnce(
      new DetachedBridgeRequestError("R close is still settling.", "timeout", true, lateClose.promise)
    );

    const close = { kind: "closeSession", sessionId, revision: 0 } as const;
    await expect(bridge.request(close)).rejects.toBeInstanceOf(DetachedBridgeRequestError);
    bridge.onIdle();
    expect(transport.dispose).not.toHaveBeenCalled();

    mapped = false;
    lateClose.resolve();
    await vi.waitFor(() => expect(transport.dispose).toHaveBeenCalledTimes(1));
  });

  it("reports idle-disposal cleanup failures", async () => {
    const transport = fakeTransport(frameContract());
    const diagnostics = vi.fn();
    const bridge = createBridge(transport, undefined, diagnostics);
    await bridge.request(openRequest());
    await bridge.request({ kind: "closeSession", sessionId, revision: 0 });
    transport.dispose.mockRejectedValueOnce(new Error("kernel cleanup failed"));

    bridge.onIdle();

    await vi.waitFor(() => expect(diagnostics).toHaveBeenCalledWith(expect.stringContaining("kernel cleanup failed")));
  });
});
