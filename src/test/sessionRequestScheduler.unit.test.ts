import { describe, expect, it, vi } from "vitest";
import type { FilterModel, OpenWranglerResponse, SessionBoundRequest } from "../shared/protocol";
import type { BridgeRequestOptions } from "../extension/dataBridge";
import { SessionRequestScheduler, sessionRequestPriority } from "../extension/sessionRequestScheduler";

const filterModel: FilterModel = { filters: [], sort: [] };

describe("SessionRequestScheduler", () => {
  it("lets interactive reads overtake queued profiling while mutations remain exclusive", async () => {
    const execution = controlledExecution();
    const scheduler = new SessionRequestScheduler(execution.execute);

    const activeProfile = scheduler.enqueue(summary("profile-active"));
    await vi.waitFor(() => expect(execution.order).toEqual(["profile-active"]));
    const queuedProfile = scheduler.enqueue(summary("profile-queued"));
    const page = scheduler.enqueue(pageRequest("page"));

    await vi.waitFor(() => expect(execution.order).toEqual(["profile-active", "page"]));
    expect(scheduler.snapshot()).toEqual({
      quiescent: false,
      activeForegroundOperation: true,
      activeBackgroundOperation: true,
      interactiveQueueLength: 0,
      backgroundQueueLength: 1,
      terminalOperation: false
    });

    const mutation = scheduler.enqueue(applyDraft());
    execution.resolve("page");
    await page;
    expect(execution.order).toEqual(["profile-active", "page"]);

    execution.resolve("profile-active");
    await activeProfile;
    await vi.waitFor(() => expect(execution.order).toEqual(["profile-active", "page", "applyDraft"]));
    execution.resolve("applyDraft");
    await mutation;
    await vi.waitFor(() => expect(execution.order).toEqual(["profile-active", "page", "applyDraft", "profile-queued"]));
    execution.resolve("profile-queued");
    await queuedProfile;
    await expect(scheduler.waitForIdle()).resolves.toBeUndefined();
    expect(scheduler.snapshot().quiescent).toBe(true);
  });

  it("promotes one selected profile, preserves its options, and cancels only cancellable view work", async () => {
    const execution = controlledExecution();
    const scheduler = new SessionRequestScheduler(execution.execute);

    const stats = scheduler.enqueue(datasetStats("stats-active"));
    await vi.waitFor(() => expect(execution.order).toEqual(["stats-active"]));
    const selected = scheduler.enqueue(summary("summary-selected"), { priority: "background", timeoutMs: 12_000 });

    scheduler.prioritizeViewRequest("summary-selected");
    await vi.waitFor(() => expect(execution.order).toEqual(["stats-active", "summary-selected"]));
    const obsoleteProfile = scheduler.enqueue(summary("profile-obsolete"));
    const obsolete = scheduler.enqueue(columnValues("values-obsolete"));
    const retainedPage = scheduler.enqueue(pageRequest("page-retained"));
    expect(execution.options.get("summary-selected")).toEqual({ priority: "interactive", timeoutMs: 12_000 });
    expect(scheduler.checkpoint("getSummary", "summary-selected")).toEqual({
      state: "active",
      lane: "foreground",
      requestKind: "getSummary",
      viewRequestId: "summary-selected"
    });
    expect(scheduler.checkpoint("getColumnValues", "values-obsolete")).toMatchObject({
      state: "queued",
      lane: "foreground"
    });

    scheduler.cancelViewRequests(["summary-selected", "profile-obsolete", "values-obsolete", "page-retained"]);
    expect(scheduler.isCancelled("summary-selected")).toBe(true);
    await expect(obsolete).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getColumnValues",
      viewRequestId: "values-obsolete"
    });
    await expect(obsoleteProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "profile-obsolete"
    });
    expect(scheduler.checkpoint("getPage", "page-retained")).toMatchObject({ state: "queued" });

    execution.resolve("summary-selected");
    await selected;
    await vi.waitFor(() => expect(scheduler.isCancelled("summary-selected")).toBe(false));
    execution.resolve("stats-active");
    await stats;
    await vi.waitFor(() => expect(execution.order.at(-1)).toBe("page-retained"));
    execution.resolve("page-retained");
    await retainedPage;
  });

  it("holds terminal close behind accepted work and resolves idle waiters only after close", async () => {
    const execution = controlledExecution();
    const scheduler = new SessionRequestScheduler(execution.execute);

    const active = scheduler.enqueue(applyDraft());
    await vi.waitFor(() => expect(execution.order).toEqual(["applyDraft"]));
    const queuedPage = scheduler.enqueue(pageRequest("page-before-close"));
    const queuedProfile = scheduler.enqueue(summary("profile-cancelled"));
    scheduler.cancelBackground();
    await expect(queuedProfile).resolves.toEqual({
      kind: "cancelled",
      targetRequestId: "session-queue:getSummary",
      viewRequestId: "profile-cancelled"
    });
    const close = scheduler.enqueue(closeSession());
    let idle = false;
    void scheduler.waitForIdle().then(() => {
      idle = true;
    });
    expect(scheduler.snapshot()).toMatchObject({
      interactiveQueueLength: 1,
      terminalOperation: true,
      quiescent: false
    });

    execution.resolve("applyDraft");
    await active;
    await vi.waitFor(() => expect(execution.order).toEqual(["applyDraft", "page-before-close"]));
    expect(idle).toBe(false);
    execution.resolve("page-before-close");
    await queuedPage;
    await vi.waitFor(() => expect(execution.order).toEqual(["applyDraft", "page-before-close", "closeSession"]));
    expect(idle).toBe(false);
    execution.resolve("closeSession");
    await close;
    await vi.waitFor(() => expect(idle).toBe(true));
    expect(scheduler.snapshot().quiescent).toBe(true);
  });

  it("rejects an ambiguous checkpoint rather than guessing between duplicate correlations", async () => {
    const execution = controlledExecution();
    const scheduler = new SessionRequestScheduler(execution.execute);
    const active = scheduler.enqueue(summary("duplicate"));
    await vi.waitFor(() => expect(execution.order).toEqual(["duplicate"]));
    const queued = scheduler.enqueue(summary("duplicate"));

    expect(() => scheduler.checkpoint("getSummary", "duplicate")).toThrow("ambiguous");

    execution.resolve("duplicate");
    await active;
    await vi.waitFor(() => expect(execution.order).toHaveLength(2));
    execution.resolve("duplicate");
    await queued;
  });

  it("uses explicit priority before the request-kind default", () => {
    expect(sessionRequestPriority(summary("default"))).toBe("background");
    expect(sessionRequestPriority(summary("selected"), { priority: "interactive" })).toBe("interactive");
    expect(sessionRequestPriority(pageRequest("page"), { priority: "background" })).toBe("background");
  });
});

function controlledExecution(): {
  readonly execute: (request: SessionBoundRequest, options?: BridgeRequestOptions) => Promise<OpenWranglerResponse>;
  readonly order: string[];
  readonly options: Map<string, BridgeRequestOptions | undefined>;
  resolve(key: string): void;
} {
  const order: string[] = [];
  const options = new Map<string, BridgeRequestOptions | undefined>();
  const pending = new Map<string, Array<(response: OpenWranglerResponse) => void>>();
  return {
    order,
    options,
    execute: (request, requestOptions) => {
      const key = requestKey(request);
      order.push(key);
      options.set(key, requestOptions);
      return new Promise((resolve) => {
        const owners = pending.get(key) ?? [];
        owners.push(resolve);
        pending.set(key, owners);
      });
    },
    resolve: (key) => {
      const owners = pending.get(key);
      const resolve = owners?.shift();
      if (!resolve) throw new Error(`No active scheduler request named ${key}.`);
      if (owners?.length === 0) pending.delete(key);
      resolve({ kind: "cancelled", targetRequestId: `test:${key}` });
    }
  };
}

function summary(viewRequestId: string): SessionBoundRequest {
  return { kind: "getSummary", sessionId: "session", revision: 0, viewRequestId, filterModel };
}

function datasetStats(viewRequestId: string): SessionBoundRequest {
  return { kind: "getDatasetStats", sessionId: "session", revision: 0, viewRequestId, filterModel };
}

function columnValues(viewRequestId: string): SessionBoundRequest {
  return {
    kind: "getColumnValues",
    sessionId: "session",
    revision: 0,
    viewRequestId,
    filterModel,
    column: "sales",
    limit: 20
  };
}

function pageRequest(viewRequestId: string): SessionBoundRequest {
  return {
    kind: "getPage",
    sessionId: "session",
    revision: 0,
    viewRequestId,
    filterModel,
    offset: 0,
    limit: 100,
    columnOffset: 0,
    columnLimit: 20
  };
}

function applyDraft(): SessionBoundRequest {
  return {
    kind: "applyDraft",
    sessionId: "session",
    revision: 0,
    offset: 0,
    limit: 100,
    columnOffset: 0,
    columnLimit: 20
  };
}

function closeSession(): SessionBoundRequest {
  return { kind: "closeSession", sessionId: "session", revision: 0 };
}

function requestKey(request: SessionBoundRequest): string {
  return "viewRequestId" in request && typeof request.viewRequestId === "string" ? request.viewRequestId : request.kind;
}
