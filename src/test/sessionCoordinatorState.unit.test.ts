import { describe, expect, it, vi } from "vitest";
import {
  activeSessionSnapshot,
  sessionCoordinatorDiagnostics,
  sessionModeName,
  sessionRequestExecutionCheckpoint,
  sessionSchedulerState,
  type ActiveSessionState
} from "../extension/sessionCoordinatorState";
import { initialViewingState } from "../extension/sessionRuntimeStateRestorer";
import { openRequest, openedResponse, stepInspectionResponse } from "./sessionCoordinatorTestFixtures";

describe("session coordinator public state", () => {
  it("publishes the exact public identity and active inspection without sharing retained state", () => {
    const opened = openedResponse("private-runtime");
    const source = { ...openRequest.source, label: "confirmed.csv" };
    const metadata = {
      ...opened.metadata,
      sessionId: "private-runtime",
      revision: 3,
      source: openRequest.source
    };
    const viewState = initialViewingState(metadata);
    const inspection = stepInspectionResponse(
      {
        kind: "inspectStep",
        sessionId: "public-session",
        revision: 7,
        stepId: "round-sales",
        offset: 0,
        limit: 20,
        columnOffset: 0,
        columnLimit: 16
      },
      0,
      "# inspected"
    );
    const session: ActiveSessionState = {
      publicId: "public-session",
      publicRevision: 7,
      metadata,
      openRequest: { source },
      code: "# confirmed",
      viewState,
      latestStepInspectionKey: "round-sales:0:20:0:16",
      stepInspection: inspection
    };

    const snapshot = activeSessionSnapshot(session);

    expect(snapshot).toEqual({
      sessionId: "public-session",
      metadata: {
        ...metadata,
        sessionId: "public-session",
        revision: 7,
        source
      },
      code: "# inspected",
      viewState,
      stepInspectionActive: true,
      stepInspection: inspection
    });
    expect(snapshot.metadata).not.toBe(metadata);
    expect(snapshot.viewState).toBe(viewState);
    expect(snapshot.stepInspection).toBe(inspection);
  });

  it("uses confirmed code and omits inspection markers when no inspection is active", () => {
    const opened = openedResponse("private-runtime");
    const viewState = initialViewingState(opened.metadata);
    const snapshot = activeSessionSnapshot({
      publicId: "public-session",
      publicRevision: 2,
      metadata: opened.metadata,
      openRequest: { source: openRequest.source },
      code: "# confirmed",
      viewState
    });

    expect(snapshot.code).toBe("# confirmed");
    expect(snapshot.viewState).toBe(viewState);
    expect(snapshot).not.toHaveProperty("stepInspectionActive");
    expect(snapshot).not.toHaveProperty("stepInspection");
  });

  it("names the two public session modes exactly", () => {
    expect(sessionModeName("editing")).toBe("Editing");
    expect(sessionModeName("viewing")).toBe("Viewing");
  });

  it("projects ordered public diagnostics without retaining private session objects", () => {
    const first = {
      publicId: "public-a",
      runtimeId: "runtime-a",
      publicRevision: 3,
      runtimeRevision: 5,
      openRequest: { source: { ...openRequest.source, label: "a.csv" } }
    };
    const second = {
      publicId: "public-b",
      runtimeId: "runtime-b",
      publicRevision: 7,
      runtimeRevision: 9,
      openRequest: { source: { ...openRequest.source, label: "b.csv" } }
    };

    expect(sessionCoordinatorDiagnostics("public-b", [first, second])).toEqual({
      activeSessionId: "public-b",
      sessionCount: 2,
      sessions: [
        {
          publicId: "public-a",
          runtimeId: "runtime-a",
          publicRevision: 3,
          runtimeRevision: 5,
          sourceLabel: "a.csv"
        },
        {
          publicId: "public-b",
          runtimeId: "runtime-b",
          publicRevision: 7,
          runtimeRevision: 9,
          sourceLabel: "b.csv"
        }
      ]
    });
  });

  it("binds test-only scheduler projections to the exact public session", () => {
    const checkpoint = vi.fn(() => ({
      state: "queued" as const,
      lane: "background" as const,
      requestKind: "getSummary" as const,
      viewRequestId: "summary-a"
    }));
    const snapshot = vi.fn(() => ({
      quiescent: false,
      activeForegroundOperation: true,
      activeBackgroundOperation: false,
      interactiveQueueLength: 2,
      backgroundQueueLength: 1,
      terminalOperation: false
    }));
    const session = { closing: false, scheduler: { checkpoint, snapshot } };

    expect(sessionRequestExecutionCheckpoint("public-a", session, "getSummary", "summary-a")).toEqual({
      sessionId: "public-a",
      state: "queued",
      lane: "background",
      requestKind: "getSummary",
      viewRequestId: "summary-a"
    });
    expect(checkpoint).toHaveBeenCalledWith("getSummary", "summary-a");
    expect(sessionSchedulerState("public-a", session)).toEqual({
      sessionId: "public-a",
      quiescent: false,
      activeForegroundOperation: true,
      activeBackgroundOperation: false,
      interactiveQueueLength: 2,
      backgroundQueueLength: 1,
      terminalOperation: false
    });
    expect(snapshot).toHaveBeenCalledOnce();

    expect(sessionRequestExecutionCheckpoint("public-a", undefined, "getSummary", "summary-a")).toBeUndefined();
    expect(
      sessionRequestExecutionCheckpoint("public-a", { ...session, closing: true }, "getSummary", "summary-a")
    ).toBeUndefined();
    expect(sessionRequestExecutionCheckpoint("public-a", session, "getSummary", "")).toBeUndefined();
    expect(sessionSchedulerState("public-a", undefined)).toBeUndefined();
    expect(checkpoint).toHaveBeenCalledOnce();
  });
});
