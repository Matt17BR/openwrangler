import { describe, expect, it, vi } from "vitest";
import type { Memento } from "vscode";
import type { OpenWranglerBridge } from "../extension/dataBridge";
import { persistedSessionState, persistenceKey, SESSION_STORAGE_KEY } from "../extension/sessionPersistence";
import { SessionPersistenceStore } from "../extension/sessionPersistenceStore";
import { SessionRuntimeEstablisher, type RuntimeEstablishmentHooks } from "../extension/sessionRuntimeEstablisher";
import { SessionRuntimeCleanup } from "../extension/sessionRuntimeCleanup";
import { SessionRuntimeStateRestorer } from "../extension/sessionRuntimeStateRestorer";
import type { OpenWranglerRequest, OpenWranglerResponse, TransformStep } from "../shared/protocol";
import { openRequest, openedResponse } from "./sessionCoordinatorTestFixtures";

describe("SessionRuntimeEstablisher", () => {
  it("publishes a public identity while retaining the exact private runtime contract", async () => {
    const runtime = openedResponse("private-runtime");
    const delegate = bridge(async () => runtime);
    const result = await establisher().establish(delegate, openRequest, undefined, undefined, hooks());

    expect(result).toMatchObject({
      established: true,
      response: { kind: "sessionOpened", metadata: { source: openRequest.source } },
      session: {
        runtimeId: "private-runtime",
        runtimeRevision: 0,
        publicRevision: 0,
        openRequest: { backend: "polars", mode: "editing", source: openRequest.source },
        closing: false,
        reconfiguring: false,
        reconnecting: false,
        recoveryRequired: false
      }
    });
    if (!result.established) throw new Error("Expected the runtime to be established.");
    expect(result.response.metadata.sessionId).not.toBe("private-runtime");
    expect(result.session.publicId).toBe(result.response.metadata.sessionId);
  });

  it("reopens immutable original data only when saved cleaning replay fails", async () => {
    const savedStep: TransformStep = {
      id: "invalid-for-source",
      kind: "dropColumns",
      params: { columns: [{ id: "c:source:0", name: "missing" }] }
    };
    const key = persistenceKey(openRequest.source, "polars");
    const stored = {
      [key]: persistedSessionState(
        { ...openedResponse().metadata, steps: [savedStep] },
        { columnWidths: {}, viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
      )
    };
    const workspaceState = {
      get: vi.fn((storageKey: string) => (storageKey === SESSION_STORAGE_KEY ? stored : undefined)),
      update: vi.fn(async () => undefined),
      keys: vi.fn(() => [SESSION_STORAGE_KEY])
    } as unknown as Memento;
    let openCount = 0;
    const executionOrder: string[] = [];
    const delegate = bridge(async (request): Promise<OpenWranglerResponse> => {
      if (request.kind === "openSession") {
        openCount += 1;
        executionOrder.push(`open-${openCount}`);
        return openedResponse(`cleaning-runtime-${openCount}`);
      }
      if (request.kind === "previewStep") {
        executionOrder.push("preview-failed");
        return {
          kind: "error",
          code: "engine_error",
          message: "The saved step no longer applies to this source.",
          recoverable: true,
          sessionId: request.sessionId
        };
      }
      if (request.kind === "closeSession") {
        executionOrder.push(`close-${request.sessionId}`);
        return { kind: "sessionClosed", sessionId: request.sessionId };
      }
      throw new Error(`Unexpected establishment request: ${request.kind}`);
    });

    const result = await establisher(workspaceState).establish(delegate, openRequest, undefined, undefined, hooks());

    expect(result).toMatchObject({
      established: true,
      response: { kind: "sessionOpened", metadata: { revision: 0, steps: [] } }
    });
    expect(executionOrder).toEqual(["open-1", "preview-failed", "close-cleaning-runtime-1", "open-2"]);
  });

  it("closes an established runtime that cannot be published", async () => {
    const requestKinds: OpenWranglerRequest["kind"][] = [];
    const delegate = bridge(async (request): Promise<OpenWranglerResponse> => {
      requestKinds.push(request.kind);
      if (request.kind === "openSession") return openedResponse("late-runtime");
      if (request.kind === "closeSession") return { kind: "sessionClosed", sessionId: request.sessionId };
      throw new Error(`Unexpected late establishment request: ${request.kind}`);
    });

    const result = await establisher().establish(delegate, openRequest, undefined, undefined, hooks(false));

    expect(result).toMatchObject({ established: false, response: { kind: "error", code: "coordinator_disposed" } });
    expect(requestKinds).toEqual(["openSession", "closeSession"]);
  });
});

function establisher(workspaceState?: Memento): SessionRuntimeEstablisher {
  return new SessionRuntimeEstablisher(
    new SessionRuntimeCleanup(() => true),
    new SessionRuntimeStateRestorer(),
    new SessionPersistenceStore(workspaceState)
  );
}

function hooks(available = true): RuntimeEstablishmentHooks {
  return {
    isCoordinatorAvailable: () => available,
    executeSessionRequest: vi.fn(async () => {
      throw new Error("The establishment tests do not dispatch session-bound work.");
    })
  };
}

function bridge(request: OpenWranglerBridge["request"]): OpenWranglerBridge {
  return { request };
}
