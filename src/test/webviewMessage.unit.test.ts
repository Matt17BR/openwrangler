import { describe, expect, it } from "vitest";
import type { SessionOpenedResponse } from "../shared/protocol";
import { decodeWebviewMessage, type WebviewMessageDecodeContext } from "../extension/webviewMessage";
import { openedResponse } from "./sessionCoordinatorTestFixtures";

const controlId = "A".repeat(32);

function context(snapshot: SessionOpenedResponse | undefined = openedResponse("runtime-session")) {
  return {
    sessionId: "public-session",
    sessionRevision: 7,
    snapshot
  } satisfies WebviewMessageDecodeContext;
}

describe("webview message decoding", () => {
  it.each([
    [{ kind: "ready" }, { kind: "ready" }],
    [{ kind: "requestSessionSnapshot" }, { kind: "requestSessionSnapshot" }],
    [
      { kind: "setViewContext", viewContextId: "view-a" },
      { kind: "setViewContext", viewContextId: "view-a" }
    ],
    [
      { kind: "prioritizeViewRequest", viewRequestId: "summary-a" },
      { kind: "prioritizeViewRequest", viewRequestId: "summary-a" }
    ],
    [{ kind: "clearStepInspection" }, { kind: "clearStepInspection" }],
    [{ kind: "changeImportOptions" }, { kind: "changeImportOptions" }],
    [
      { kind: "changeImportOptions", actionId: controlId },
      { kind: "changeImportOptions", actionId: controlId }
    ],
    [{ kind: "changeBackend" }, { kind: "changeBackend" }],
    [{ kind: "installRuntimeDependencies" }, { kind: "installRuntimeDependencies" }],
    [{ kind: "exportData" }, { kind: "exportData" }],
    [{ kind: "reconnectLiveSource" }, { kind: "reconnectLiveSource" }]
  ])("accepts the exact control shape %#", (message, expected) => {
    expect(decodeWebviewMessage(message, context())).toEqual(expected);
    expect(decodeWebviewMessage({ ...message, unexpected: true }, context())).toBeUndefined();
  });

  it("requires one exact renderer identity shape", () => {
    expect(
      decodeWebviewMessage(
        { kind: "rendererSynchronized", syncId: controlId, sessionId: "public-session", revision: 7 },
        context()
      )
    ).toEqual({
      kind: "rendererSynchronized",
      syncId: controlId,
      sessionId: "public-session",
      revision: 7
    });
    expect(
      decodeWebviewMessage({ kind: "rendererRetiring", syncId: controlId, sessionId: null, revision: null }, context())
    ).toEqual({ kind: "rendererRetiring", syncId: controlId, sessionId: null, revision: null });

    for (const message of [
      { kind: "rendererSynchronized", syncId: "short", sessionId: "public-session", revision: 7 },
      { kind: "rendererSynchronized", syncId: controlId, sessionId: "", revision: 7 },
      { kind: "rendererSynchronized", syncId: controlId, sessionId: "public-session", revision: -1 },
      { kind: "rendererSynchronized", syncId: controlId, sessionId: null, revision: 7 },
      { kind: "rendererSynchronized", syncId: controlId, sessionId: "public-session", revision: null }
    ]) {
      expect(decodeWebviewMessage(message, context())).toBeUndefined();
    }
  });

  it("copies only bounded non-empty view request identities", () => {
    const viewRequestIds = ["summary-a", "stats-a"];
    const decoded = decodeWebviewMessage({ kind: "cancelViewRequests", viewRequestIds }, context());
    expect(decoded).toEqual({ kind: "cancelViewRequests", viewRequestIds });
    if (decoded?.kind !== "cancelViewRequests") throw new Error("Expected a cancellation message.");
    expect(decoded.viewRequestIds).not.toBe(viewRequestIds);

    expect(
      decodeWebviewMessage({ kind: "cancelViewRequests", viewRequestIds: ["summary-a", ""] }, context())
    ).toBeUndefined();
    expect(decodeWebviewMessage({ kind: "prioritizeViewRequest", viewRequestId: "" }, context())).toBeUndefined();
  });

  it("accepts only an exact bounded host-owned plan rewrite", () => {
    const message = {
      kind: "rewriteCleaningPlan",
      action: "deleteStep",
      stepId: "stable-step-id",
      offset: 0,
      limit: 200,
      columnOffset: 0,
      columnLimit: 32
    } as const;
    expect(decodeWebviewMessage(message, context())).toEqual(message);
    for (const invalid of [
      { ...message, stepId: "" },
      { ...message, action: "moveStep" },
      { ...message, limit: 0 },
      { ...message, columnLimit: 257 },
      { ...message, unexpected: true }
    ]) {
      expect(decodeWebviewMessage(invalid, context())).toBeUndefined();
    }
  });

  it("stamps runtime requests with host-owned identity and limits scheduling hints", () => {
    const request = {
      kind: "getSummary",
      viewRequestId: "summary-a",
      filterModel: { filters: [], sort: [] },
      columnIds: ["c:0"]
    } as const;
    expect(
      decodeWebviewMessage(
        { kind: "runtimeRequest", request, viewContextId: "view-a", priority: "background" },
        context()
      )
    ).toEqual({
      kind: "runtimeRequest",
      request: { ...request, sessionId: "public-session", revision: 7 },
      viewContextId: "view-a",
      priority: "background"
    });

    expect(
      decodeWebviewMessage({ kind: "runtimeRequest", request: { ...request, sessionId: "forged" } }, context())
    ).toBeUndefined();
    expect(
      decodeWebviewMessage({ kind: "runtimeRequest", request: { ...request, revision: 99 } }, context())
    ).toBeUndefined();
    expect(
      decodeWebviewMessage(
        {
          kind: "runtimeRequest",
          request: { kind: "undoStep", offset: 0, limit: 20, columnOffset: 0, columnLimit: 16 },
          priority: "interactive"
        },
        context()
      )
    ).toBeUndefined();
    expect(
      decodeWebviewMessage({ kind: "runtimeRequest", request: { kind: "closeSession" } }, context())
    ).toBeUndefined();
  });

  it("accepts only an exact current-view clipboard-column page purpose", () => {
    const request = {
      kind: "getPage",
      viewRequestId: "clipboard-column-a",
      offset: 0,
      limit: 200,
      columnOffset: 3,
      columnLimit: 1,
      filterModel: { filters: [], sort: [] }
    } as const;
    expect(
      decodeWebviewMessage(
        { kind: "runtimeRequest", purpose: "clipboardColumn", viewContextId: "view-a", request },
        context()
      )
    ).toEqual({
      kind: "runtimeRequest",
      purpose: "clipboardColumn",
      viewContextId: "view-a",
      request: { ...request, sessionId: "public-session", revision: 7 }
    });

    for (const invalid of [
      { kind: "runtimeRequest", purpose: "clipboardColumn", request },
      {
        kind: "runtimeRequest",
        purpose: "clipboardColumn",
        priority: "interactive",
        viewContextId: "view-a",
        request
      },
      {
        kind: "runtimeRequest",
        purpose: "clipboardColumn",
        viewContextId: "view-a",
        request: { kind: "getDatasetStats", viewRequestId: "stats", filterModel: { filters: [], sort: [] } }
      },
      { kind: "runtimeRequest", purpose: "export", viewContextId: "view-a", request }
    ]) {
      expect(decodeWebviewMessage(invalid, context())).toBeUndefined();
    }
  });

  it("fails closed on preview capability before exposing a runtime request", () => {
    const preview = {
      kind: "runtimeRequest",
      request: {
        kind: "previewStep",
        step: {
          id: "round-sales",
          kind: "roundNumber",
          params: { column: { id: "c:sales", name: "sales" }, decimals: 0 }
        },
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16
      }
    } as const;
    const opened = openedResponse("runtime-session");
    const supported: SessionOpenedResponse = {
      ...opened,
      metadata: {
        ...opened.metadata,
        capabilities: { ...opened.metadata.capabilities, supportedOperations: ["roundNumber"] }
      }
    };
    const unsupported: SessionOpenedResponse = {
      ...opened,
      metadata: {
        ...opened.metadata,
        capabilities: { ...opened.metadata.capabilities, supportedOperations: ["renameColumn"] }
      }
    };

    expect(decodeWebviewMessage(preview, { ...context(), snapshot: undefined })).toBeUndefined();
    expect(decodeWebviewMessage(preview, context(unsupported))).toBeUndefined();
    expect(decodeWebviewMessage(preview, context(supported))).toMatchObject({
      kind: "runtimeRequest",
      request: { kind: "previewStep", sessionId: "public-session", revision: 7 }
    });
  });
});
