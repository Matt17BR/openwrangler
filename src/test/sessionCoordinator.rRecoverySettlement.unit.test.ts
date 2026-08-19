import { describe, expect, it, vi } from "vitest";
import { DetachedBridgeRequestError, type OpenWranglerBridge } from "../extension/dataBridge";
import { SessionCoordinator } from "../extension/sessionCoordinator";
import type { OpenWranglerRequest, OpenWranglerResponse } from "../shared/protocol";
import { nativeRKernelChangedResponse, type NativeRRecoveryBridge } from "./nativeRRecoveryTestFixtures";
import {
  columnWindow,
  deferred,
  openRequest,
  openedResponse,
  pageResponseForMetadata
} from "./sessionCoordinatorTestFixtures";

describe("SessionCoordinator Native-R recovery settlement", () => {
  it("keeps shutdown behind the detached old-runtime close settlement", async () => {
    const oldCloseSettlement = deferred<void>();
    const oldRequests: OpenWranglerRequest[] = [];
    const candidateRequests: OpenWranglerRequest[] = [];
    const oldDelegate: OpenWranglerBridge = {
      request: vi.fn(async (request): Promise<OpenWranglerResponse> => {
        oldRequests.push(request);
        if (request.kind === "openSession") return openedResponse("runtime-old", "r");
        if (request.kind === "getPage") return nativeRKernelChangedResponse(request);
        if (request.kind === "closeSession") {
          throw new DetachedBridgeRequestError(
            "The old R runtime close exceeded its host deadline.",
            "timeout",
            true,
            oldCloseSettlement.promise
          );
        }
        throw new Error(`Unexpected old-runtime request: ${request.kind}`);
      })
    };
    const candidateOpened = openedResponse("runtime-new", "r");
    const candidateDelegate: OpenWranglerBridge = {
      request: vi.fn(async (request): Promise<OpenWranglerResponse> => {
        candidateRequests.push(request);
        if (request.kind === "openSession") return candidateOpened;
        if (request.kind === "getPage") return pageResponseForMetadata(request, candidateOpened.metadata);
        if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
        throw new Error(`Unexpected replacement-runtime request: ${request.kind}`);
      })
    };
    Object.assign(oldDelegate, { supportsVerifiedRuntimeRecoveryDelegate: true });
    (oldDelegate as NativeRRecoveryBridge).createRuntimeRecoveryDelegate = vi.fn(async () => ({
      delegate: candidateDelegate,
      dispose: vi.fn(async () => undefined)
    }));
    const coordinator = new SessionCoordinator();
    const bridge = coordinator.createBridge(oldDelegate);
    const opened = await bridge.request({ ...openRequest, backend: "r" });
    if (opened.kind !== "sessionOpened") throw new Error("Expected the original Native-R session to open.");

    await expect(
      bridge.request({
        kind: "getPage",
        sessionId: opened.metadata.sessionId,
        revision: opened.metadata.revision,
        viewRequestId: "detached-old-runtime-close",
        offset: 0,
        limit: 10,
        ...columnWindow,
        filterModel: opened.metadata.filterModel
      })
    ).resolves.toMatchObject({
      kind: "error",
      code: "r_kernel_changed",
      sessionId: opened.metadata.sessionId
    });
    await vi.waitFor(() => expect(oldRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1));

    let shutdownSettled = false;
    const shutdown = coordinator.shutdown(10_000).then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);
    await vi.waitFor(() =>
      expect(candidateRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1)
    );
    expect(shutdownSettled).toBe(false);

    oldCloseSettlement.resolve(undefined);
    await shutdown;
    expect(shutdownSettled).toBe(true);
    expect(oldRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1);
    expect(candidateRequests.filter((request) => request.kind === "closeSession")).toHaveLength(1);
  });
});
