import type { ErrorResponse, OpenWranglerRequest } from "../shared/protocol";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import type { RuntimeRecoveryDelegateFactory } from "../extension/sessionRuntimeRecovery";

export type NativeRRecoveryBridge = OpenWranglerBridge & RuntimeRecoveryDelegateFactory;

export function nativeRKernelChangedResponse(
  request: Extract<OpenWranglerRequest, { kind: "getPage" | "getSummary" }>
): ErrorResponse {
  return {
    kind: "error",
    code: "r_kernel_changed",
    message: "The selected R notebook kernel changed.",
    recoverable: true,
    sessionId: request.sessionId,
    viewRequestId: request.viewRequestId
  };
}
