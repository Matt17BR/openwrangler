import { describe, expect, it, vi } from "vitest";
import type {
  OpenSessionRequest,
  OpenWranglerRequest,
  OpenWranglerResponse,
  SessionOpenedResponse,
  SessionMetadata
} from "../shared/protocol";
import {
  PythonSessionOwnership,
  type PythonSessionPendingRequest,
  type PythonSessionRuntime
} from "../extension/pythonSessionOwnership";

interface TestRuntime extends PythonSessionRuntime {
  readonly key: string;
}

describe("PythonSessionOwnership", () => {
  it("promotes only the exact correlated requested-session reservation", () => {
    const restart = vi.fn();
    const ownership = new PythonSessionOwnership<TestRuntime>(restart);
    const runtime = testRuntime("workspace");
    const request = openRequest("candidate");

    expect(ownership.reserve(request, runtime, "open-1")).toBeUndefined();
    expect(ownership.provisionalClaim("candidate")).toEqual({
      runtime,
      openRequestId: "open-1",
      state: "pending"
    });
    expect(ownership.confirmedOwner("candidate")).toBeUndefined();

    const response = ownership.finalizeResponse(pending(request, runtime, "open-1"), opened(request, "candidate"));
    expect(response.kind).toBe("sessionOpened");
    expect(ownership.provisionalClaim("candidate")).toBeUndefined();
    expect(ownership.confirmedOwner("candidate")).toBe(runtime);
    expect(runtime.provisionalSessionIds).toEqual(new Set());
    expect(runtime.sessionIds).toEqual(new Set(["candidate"]));
    expect(restart).not.toHaveBeenCalled();
  });

  it("rejects duplicate confirmed or provisional identities without stealing ownership", () => {
    const ownership = new PythonSessionOwnership<TestRuntime>(vi.fn());
    const first = testRuntime("first");
    const second = testRuntime("second");
    const request = openRequest("shared");

    expect(ownership.reserve(request, first, "first-open")).toBeUndefined();
    expect(ownership.reserve(request, second, "second-open")).toMatchObject({
      kind: "error",
      code: "duplicate_runtime_session",
      sessionId: "shared",
      message: expect.stringContaining("Python scope first")
    });
    ownership.finalizeResponse(pending(request, first, "first-open"), opened(request, "shared"));
    expect(ownership.reserve(request, second, "second-open")).toMatchObject({
      kind: "error",
      code: "duplicate_runtime_session",
      message: expect.stringContaining("Python scope first")
    });
    expect(ownership.confirmedOwner("shared")).toBe(first);
    expect(second.sessionIds).toEqual(new Set());
  });

  it("releases a reservation on a correlated non-open response", () => {
    const ownership = new PythonSessionOwnership<TestRuntime>(vi.fn());
    const runtime = testRuntime("scope");
    const released = openRequest("released");

    ownership.reserve(released, runtime, "released-open");
    expect(
      ownership.finalizeResponse(pending(released, runtime, "released-open"), {
        kind: "cancelled",
        targetRequestId: "released-open"
      })
    ).toEqual({ kind: "cancelled", targetRequestId: "released-open" });
    expect(ownership.provisionalClaim("released")).toBeUndefined();
  });

  it.each([
    {
      label: "correlated close",
      response: { kind: "sessionClosed", sessionId: "candidate" } as OpenWranglerResponse,
      reservationRemains: false
    },
    {
      label: "confirmed absence",
      response: {
        kind: "error",
        code: "unknown_session",
        message: "Unknown session: candidate",
        recoverable: true,
        sessionId: "candidate"
      } as OpenWranglerResponse,
      reservationRemains: false
    },
    {
      label: "ambiguous cleanup failure",
      response: {
        kind: "error",
        code: "engine_error",
        message: "Cleanup failed before confirmation.",
        recoverable: true,
        sessionId: "candidate"
      } as OpenWranglerResponse,
      reservationRemains: true
    }
  ])("never promotes a delayed open after $label", ({ response, reservationRemains }) => {
    const restart = vi.fn((runtime: TestRuntime) => ownership.releaseRuntime(runtime));
    const ownership = new PythonSessionOwnership<TestRuntime>(restart);
    const runtime = testRuntime("scope");
    const request = openRequest("candidate");
    ownership.reserve(request, runtime, "open");
    ownership.markProvisionalClosing("candidate", runtime);

    const close = { kind: "closeSession", sessionId: "candidate", revision: 0 } as const;
    expect(ownership.finalizeResponse(pending(close, runtime, "close"), response)).toBe(response);
    expect(ownership.provisionalClaim("candidate") !== undefined).toBe(reservationRemains);
    expect(ownership.finalizeResponse(pending(request, runtime, "open"), opened(request, "candidate"))).toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      sessionId: "candidate"
    });
    expect(restart).toHaveBeenCalledWith(runtime, expect.stringContaining("reservation ended"));
    expect(ownership.confirmedOwner("candidate")).toBeUndefined();
  });

  it.each([
    {
      label: "mismatched identity",
      prepare: (_ownership: PythonSessionOwnership<TestRuntime>, _runtime: TestRuntime) => undefined,
      actual: "other",
      reason: "instead of requested session"
    },
    {
      label: "ended reservation",
      prepare: (ownership: PythonSessionOwnership<TestRuntime>, runtime: TestRuntime) => {
        ownership.markProvisionalClosing("candidate", runtime);
      },
      actual: "candidate",
      reason: "reservation ended"
    }
  ])("fails closed and restarts only the affected scope for a $label", ({ prepare, actual, reason }) => {
    const restart = vi.fn((runtime: TestRuntime) => ownership.releaseRuntime(runtime));
    const ownership = new PythonSessionOwnership<TestRuntime>(restart);
    const runtime = testRuntime("affected");
    const request = openRequest("candidate");
    ownership.reserve(request, runtime, "open");
    prepare(ownership, runtime);

    expect(ownership.finalizeResponse(pending(request, runtime, "open"), opened(request, actual))).toMatchObject({
      kind: "error",
      code: "invalid_runtime_response",
      sessionId: "candidate"
    });
    expect(restart).toHaveBeenCalledWith(runtime, expect.stringContaining(reason));
    expect(ownership.confirmedOwner("candidate")).toBeUndefined();
    expect(ownership.provisionalClaim("candidate")).toBeUndefined();
  });

  it("rejects a cross-session response and releases only exact authoritative closes", () => {
    const restart = vi.fn((runtime: TestRuntime) => ownership.releaseRuntime(runtime));
    const ownership = new PythonSessionOwnership<TestRuntime>(restart);
    const runtime = testRuntime("scope");
    const request = openRequest("confirmed");
    ownership.reserve(request, runtime, "open");
    ownership.finalizeResponse(pending(request, runtime, "open"), opened(request, "confirmed"));

    const pageRequest: OpenWranglerRequest = {
      kind: "getPage",
      sessionId: "confirmed",
      revision: 0,
      viewRequestId: "page",
      offset: 0,
      limit: 10,
      columnOffset: 0,
      columnLimit: 10,
      filterModel: { filters: [], sort: [] }
    };
    expect(
      ownership.finalizeResponse(pending(pageRequest, runtime, "page"), {
        kind: "error",
        code: "engine_error",
        message: "wrong owner",
        recoverable: true,
        sessionId: "other"
      })
    ).toMatchObject({ kind: "error", code: "invalid_runtime_response", sessionId: "confirmed" });
    expect(restart).toHaveBeenCalledWith(runtime, expect.stringContaining("other instead of confirmed"));

    const reopened = openRequest("confirmed");
    ownership.reserve(reopened, runtime, "reopen");
    ownership.finalizeResponse(pending(reopened, runtime, "reopen"), opened(reopened, "confirmed"));
    const closeRequest: OpenWranglerRequest = { kind: "closeSession", sessionId: "confirmed", revision: 0 };
    expect(
      ownership.finalizeResponse(pending(closeRequest, runtime, "close"), {
        kind: "error",
        code: "engine_error",
        message: "Unknown session: confirmed",
        recoverable: true
      })
    ).toMatchObject({ kind: "error", code: "engine_error" });
    expect(ownership.confirmedOwner("confirmed")).toBeUndefined();
  });

  it("releases all and only the claims owned by one failed runtime", () => {
    const ownership = new PythonSessionOwnership<TestRuntime>(vi.fn());
    const first = testRuntime("first");
    const second = testRuntime("second");
    confirm(ownership, first, "first-confirmed");
    confirm(ownership, second, "second-confirmed");
    ownership.reserve(openRequest("first-pending"), first, "first-pending-open");
    ownership.reserve(openRequest("second-pending"), second, "second-pending-open");

    ownership.releaseRuntime(first);

    expect(ownership.confirmedOwner("first-confirmed")).toBeUndefined();
    expect(ownership.provisionalClaim("first-pending")).toBeUndefined();
    expect(ownership.confirmedOwner("second-confirmed")).toBe(second);
    expect(ownership.provisionalClaim("second-pending")?.runtime).toBe(second);
    expect(ownership.hasClaimsFor(first)).toBe(false);
    expect(ownership.hasClaimsFor(second)).toBe(true);
  });
});

function confirm(ownership: PythonSessionOwnership<TestRuntime>, runtime: TestRuntime, sessionId: string): void {
  const request = openRequest(sessionId);
  ownership.reserve(request, runtime, `${sessionId}-open`);
  ownership.finalizeResponse(pending(request, runtime, `${sessionId}-open`), opened(request, sessionId));
}

function pending(
  request: OpenWranglerRequest,
  runtime: TestRuntime,
  requestId: string
): PythonSessionPendingRequest<TestRuntime> {
  return { request, runtime, requestId };
}

function testRuntime(key: string): TestRuntime {
  return { key, provisionalSessionIds: new Set(), sessionIds: new Set() };
}

function openRequest(requestedSessionId: string): OpenSessionRequest {
  return {
    kind: "openSession",
    requestedSessionId,
    source: { kind: "file", label: "data.csv", path: "/workspace/data.csv" },
    backend: "polars",
    pageSize: 100,
    columnOffset: 0,
    columnLimit: 20
  };
}

function opened(request: OpenSessionRequest, sessionId: string): SessionOpenedResponse {
  const metadata: SessionMetadata = {
    protocolVersion: 2,
    sessionId,
    revision: 0,
    backend: "polars",
    mode: "editing",
    source: request.source,
    capabilities: {
      editable: true,
      lazy: true,
      cancel: true,
      exportCsv: true,
      exportParquet: true,
      notebookInsert: false
    },
    shape: { rows: 0, columns: 0 },
    filteredShape: { rows: 0, columns: 0 },
    schema: [],
    filterModel: { filters: [], sort: [] },
    steps: []
  };
  return {
    kind: "sessionOpened",
    metadata,
    page: { offset: 0, limit: 100, totalRows: 0, columnIds: [], rows: [] },
    summaries: []
  };
}
