import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilterModel } from "../shared/filterModel";
import type { ColumnSummary, SessionMetadata, ValuesResponse } from "../shared/protocol";

const postMessage = vi.hoisted(() => vi.fn());
vi.mock("../webviews/vscodeApi", () => ({
  vscode: { postMessage, getState: () => undefined, setState: () => undefined }
}));

import {
  useProgressiveProfilingLifecycle,
  type ConfirmedProfileView,
  type ProgressiveProfilingDrawerDemand
} from "../webviews/progressiveProfilingLifecycle";

const metadata: SessionMetadata = {
  protocolVersion: 4,
  sessionId: "session",
  revision: 7,
  backend: "polars",
  mode: "editing",
  source: { kind: "file", label: "sample.csv", path: "sample.csv" },
  capabilities: {
    editable: true,
    lazy: true,
    cancel: true,
    exportCsv: true,
    exportParquet: true,
    notebookInsert: false
  },
  shape: { rows: 500, columns: 2 },
  filteredShape: { rows: 500, columns: 2 },
  filterModel: { filters: [], sort: [] },
  steps: [],
  schema: [
    { id: "c:0", name: "city", position: 0, rawType: "String", type: "string", nullable: false },
    { id: "c:1", name: "sales", position: 1, rawType: "Float64", type: "float", nullable: false }
  ]
};

const citySummary: ColumnSummary = {
  columnId: "c:0",
  column: "city",
  type: "string",
  rawType: "String",
  totalCount: 500,
  nullCount: 0,
  nanCount: 0,
  distinctCount: 1,
  topValues: [{ value: "Berlin", count: 500 }]
};

const closedDrawer: ProgressiveProfilingDrawerDemand = {
  open: false,
  view: "column",
  suspended: false,
  viewContextId: "view-a"
};

describe("progressive profiling lifecycle", () => {
  let sequence: number;
  let confirmed: ConfirmedProfileView;
  let profileAllowed: boolean;
  const nextViewRequestId = () => `profile-${++sequence}`;
  const readConfirmedView = () => confirmed;
  const canProfileConfirmedView = (viewContextId: string) =>
    profileAllowed && confirmed.view.viewContextId === viewContextId;

  beforeEach(() => {
    sequence = 0;
    confirmed = confirmedView(metadata, "view-a");
    profileAllowed = true;
    postMessage.mockClear();
  });

  it("shares summary ownership and retains drawer demand across cancellation-only restarts", async () => {
    const { result, rerender } = renderLifecycle(closedDrawer);

    act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
    const initial = onlyRuntimeEnvelope("getSummary");
    expect(initial.priority).toBe("background");

    rerender({
      drawer: {
        ...closedDrawer,
        open: true,
        selectedColumnId: "c:0"
      }
    });
    await waitFor(() => expect(prioritizedRequestIds()).toEqual([initial.request.viewRequestId]));
    expect(runtimeEnvelopes("getSummary")).toHaveLength(1);

    postMessage.mockClear();
    act(() => result.current.updateVisibleSummaryColumns([]));
    expect(cancelledRequestIds()).toHaveLength(0);

    act(() => result.current.cancelPendingProfiling());
    expect(cancelledRequestIds()).toEqual([initial.request.viewRequestId]);

    postMessage.mockClear();
    act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
    const replacement = onlyRuntimeEnvelope("getSummary");
    expect(replacement.request.viewRequestId).not.toBe(initial.request.viewRequestId);

    postMessage.mockClear();
    act(() => result.current.updateVisibleSummaryColumns([]));
    expect(cancelledRequestIds()).toHaveLength(0);

    act(() => result.current.releaseDrawerProfiling());
    expect(cancelledRequestIds()).toEqual([replacement.request.viewRequestId]);
  });

  it("accepts only the current view and latest values correlation", () => {
    const { result } = renderLifecycle(closedDrawer);
    act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
    const staleSummary = onlyRuntimeEnvelope("getSummary").request.viewRequestId;

    confirmed = confirmedView(metadata, "view-b");
    act(() =>
      result.current.settleProfileMessage({
        kind: "summary",
        revision: metadata.revision,
        viewRequestId: staleSummary,
        summaries: [citySummary]
      })
    );
    expect(result.current.summaries).toEqual([]);

    postMessage.mockClear();
    act(() => result.current.requestValues("city"));
    const firstValues = onlyRuntimeEnvelope("getColumnValues").request.viewRequestId;
    act(() => result.current.requestValues("city", "mil"));
    const latestValues = runtimeEnvelopes("getColumnValues").at(-1)?.request.viewRequestId;
    if (!latestValues) throw new Error("Expected a latest values request.");
    expect(cancelledRequestIds()).toContain(firstValues);

    act(() => {
      result.current.settleProfileMessage(valuesResponse(firstValues, "Berlin"));
      result.current.settleProfileMessage(valuesResponse(latestValues, "Milan"));
    });
    expect(result.current.columnValues.get("city")?.values).toEqual([{ value: "Milan", count: 1 }]);
  });

  it.each(["server_busy", "bridge_error"])(
    "retries %s with a fresh correlation and clears its diagnostic on success",
    (code) => {
      vi.useFakeTimers();
      const { result, unmount } = renderLifecycle(closedDrawer);
      try {
        act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
        const first = onlyRuntimeEnvelope("getSummary").request.viewRequestId;

        act(() =>
          result.current.settleProfileMessage({
            kind: "error",
            code,
            message: "Profile failed once",
            recoverable: true,
            viewRequestId: first
          })
        );
        expect([...result.current.backgroundDiagnostics.values()].map(({ message }) => message)).toEqual([
          "Profile failed once"
        ]);

        act(() => vi.runOnlyPendingTimers());
        const retry = runtimeEnvelopes("getSummary").at(-1)?.request.viewRequestId;
        if (!retry) throw new Error("Expected a retried summary request.");
        expect(retry).not.toBe(first);

        act(() =>
          result.current.settleProfileMessage({
            kind: "summary",
            revision: metadata.revision,
            viewRequestId: retry,
            summaries: [citySummary]
          })
        );
        expect(result.current.summaries).toEqual([citySummary]);
        expect(result.current.backgroundDiagnostics.size).toBe(0);
      } finally {
        unmount();
        vi.useRealTimers();
      }
    }
  );

  it("keeps semantic summary and stats refusals until fresh profiling demand succeeds", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderLifecycle({ ...closedDrawer, open: true, view: "dataset" });
    try {
      act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
      const firstSummary = onlyRuntimeEnvelope("getSummary").request.viewRequestId;
      const firstStats = onlyRuntimeEnvelope("getDatasetStats").request.viewRequestId;
      act(() => {
        for (const viewRequestId of [firstSummary, firstStats]) {
          result.current.settleProfileMessage({
            kind: "error",
            code: "engine_error",
            message: "Value cannot be represented without losing precision",
            recoverable: true,
            viewRequestId
          });
        }
        vi.runOnlyPendingTimers();
      });
      expect(runtimeEnvelopes("getSummary")).toHaveLength(1);
      expect(runtimeEnvelopes("getDatasetStats")).toHaveLength(1);
      expect(result.current.backgroundDiagnostics.size).toBe(2);

      postMessage.mockClear();
      act(() => result.current.restartProfilingForConfirmedView());
      const summary = onlyRuntimeEnvelope("getSummary").request.viewRequestId;
      const stats = onlyRuntimeEnvelope("getDatasetStats").request.viewRequestId;
      expect(summary).not.toBe(firstSummary);
      expect(stats).not.toBe(firstStats);
      act(() => {
        result.current.settleProfileMessage({
          kind: "summary",
          revision: metadata.revision,
          viewRequestId: summary,
          summaries: [citySummary]
        });
        result.current.settleProfileMessage({
          kind: "datasetStats",
          revision: metadata.revision,
          viewRequestId: stats,
          stats: emptyStats()
        });
      });
      expect(result.current.summaries).toEqual([citySummary]);
      expect(result.current.backgroundDiagnostics.size).toBe(0);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("returns accepted dataset statistics to App while stale statistics remain unpublished", async () => {
    const drawer: ProgressiveProfilingDrawerDemand = {
      ...closedDrawer,
      open: true,
      view: "dataset"
    };
    const { result, rerender } = renderLifecycle(drawer);
    await waitFor(() => expect(runtimeEnvelopes("getDatasetStats")).toHaveLength(1));
    const stale = onlyRuntimeEnvelope("getDatasetStats").request.viewRequestId;

    confirmed = confirmedView(metadata, "view-b");
    let settlement: ReturnType<typeof result.current.settleProfileMessage> | undefined;
    act(() => {
      settlement = result.current.settleProfileMessage({
        kind: "datasetStats",
        revision: metadata.revision,
        viewRequestId: stale,
        stats: emptyStats()
      });
    });
    expect(settlement?.stats).toBeUndefined();

    rerender({ drawer: { ...drawer, viewContextId: "view-b" } });
    await waitFor(() => expect(runtimeEnvelopes("getDatasetStats")).toHaveLength(2));
    const current = runtimeEnvelopes("getDatasetStats").at(-1)?.request.viewRequestId;
    if (!current) throw new Error("Expected current dataset statistics.");
    act(() => {
      settlement = result.current.settleProfileMessage({
        kind: "datasetStats",
        revision: metadata.revision,
        viewRequestId: current,
        stats: emptyStats()
      });
    });
    expect(settlement?.stats).toEqual(emptyStats());
  });

  it("captures and restores an isolated rollback snapshot", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderLifecycle(closedDrawer);
    try {
      act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
      const summaryRequest = onlyRuntimeEnvelope("getSummary").request.viewRequestId;
      act(() =>
        result.current.settleProfileMessage({
          kind: "error",
          code: "profile_failed",
          message: "Retain this warning",
          recoverable: true,
          viewRequestId: summaryRequest
        })
      );
      act(() => result.current.requestValues("city"));
      const valuesRequest = onlyRuntimeEnvelope("getColumnValues").request.viewRequestId;
      act(() => result.current.settleProfileMessage(valuesResponse(valuesRequest, "Owned value")));

      const snapshot = result.current.captureProfileState();
      const snapshotValues = snapshot.columnValues as Map<string, ValuesResponse>;
      snapshotValues.clear();
      expect(result.current.columnValues.get("city")?.values[0]?.value).toBe("Owned value");

      const rollback = result.current.captureProfileState();
      act(() => result.current.resetViewProfiling());
      expect(result.current.columnValues.size).toBe(0);
      expect(result.current.backgroundDiagnostics.size).toBe(0);

      act(() => result.current.restoreProfileState(rollback));
      expect(result.current.columnValues.get("city")?.values[0]?.value).toBe("Owned value");
      expect([...result.current.backgroundDiagnostics.values()].map(({ message }) => message)).toEqual([
        "Retain this warning"
      ]);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it.each(["own column", "sort", "global logic"] as const)(
    "retains cached values only when their full query is unchanged after changing %s",
    (change) => {
      const previous: FilterModel = {
        filters: [
          { column: "city", type: "string", predicates: [{ kind: "predicate", operator: "equals", value: "Berlin" }] },
          { column: "sales", type: "float", predicates: [{ kind: "predicate", operator: "gt", value: "10" }] },
          { column: "region", type: "string", predicates: [{ kind: "predicate", operator: "equals", value: "Europe" }] }
        ],
        sort: []
      };
      confirmed = confirmedView(
        {
          ...metadata,
          filterModel: previous,
          shape: { rows: 500, columns: 3 },
          filteredShape: { rows: 500, columns: 3 },
          schema: [
            ...metadata.schema,
            { id: "c:2", name: "region", position: 2, rawType: "String", type: "string", nullable: false }
          ]
        },
        "view-a"
      );
      const { result } = renderLifecycle(closedDrawer);
      for (const column of ["city", "sales"]) {
        act(() => result.current.requestValues(column));
        const request = runtimeEnvelopes("getColumnValues").at(-1)!;
        act(() =>
          result.current.settleProfileMessage({ ...valuesResponse(request.request.viewRequestId, column), column })
        );
      }
      const next: FilterModel =
        change === "own column"
          ? { ...previous, filters: previous.filters.slice(1) }
          : change === "sort"
            ? { ...previous, sort: [{ column: "sales", direction: "asc", nulls: "last" }] }
            : { ...previous, logic: "or" };
      act(() => result.current.resetViewProfiling({ preserveColumnValuesFor: next }));
      expect([...result.current.columnValues.keys()]).toEqual(change === "own column" ? ["city"] : []);
      expect(runtimeEnvelopes("getColumnValues")).toHaveLength(2);
    }
  );

  it("keeps automatic profiles quiet after a non-cancellable mutation and prunes removed columns", () => {
    vi.useFakeTimers();
    confirmed = confirmedView({ ...metadata, capabilities: { ...metadata.capabilities, cancel: false } }, "view-a");
    const { result, unmount } = renderLifecycle(closedDrawer);
    try {
      act(() => result.current.updateVisibleSummaryColumns(["c:0", "c:1"]));
      act(() =>
        result.current.resetViewProfiling({
          initialSummaries: []
        })
      );
      postMessage.mockClear();

      const narrowedMetadata: SessionMetadata = { ...confirmed.metadata, schema: [confirmed.metadata.schema[0]!] };
      confirmed = confirmedView(narrowedMetadata, "view-b");
      act(() => result.current.restartProfilingAfterMutation(narrowedMetadata));
      expect(runtimeEnvelopes("getSummary")).toHaveLength(0);

      act(() => vi.advanceTimersByTime(1_999));
      expect(runtimeEnvelopes("getSummary")).toHaveLength(0);
      act(() => vi.advanceTimersByTime(1));
      expect(runtimeEnvelopes("getSummary").map(({ request }) => request.columnIds)).toEqual([["c:0"]]);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("leaves lost Spark profile recovery as an App-owned foreground decision", () => {
    const { result } = renderLifecycle(closedDrawer);
    act(() => result.current.updateVisibleSummaryColumns(["c:0"]));
    const request = onlyRuntimeEnvelope("getSummary").request.viewRequestId;

    let settlement: ReturnType<typeof result.current.settleProfileMessage> | undefined;
    act(() => {
      settlement = result.current.settleProfileMessage({
        kind: "error",
        code: "pyspark_connect_state_lost",
        message: "Reconnect the live dataframe.",
        recoverable: true,
        viewRequestId: request
      });
    });

    expect(settlement).toEqual({ handled: true, foregroundError: "Reconnect the live dataframe." });
    expect(result.current.backgroundDiagnostics.size).toBe(0);
  });

  function renderLifecycle(drawer: ProgressiveProfilingDrawerDemand) {
    return renderHook(
      ({ drawer: currentDrawer }) =>
        useProgressiveProfilingLifecycle({
          nextViewRequestId,
          readConfirmedView,
          canProfileConfirmedView,
          drawerDemand: currentDrawer
        }),
      { initialProps: { drawer } }
    );
  }
});

interface RuntimeEnvelope {
  kind: "runtimeRequest";
  priority?: "background" | "interactive";
  viewContextId: string;
  request: {
    kind: string;
    viewRequestId: string;
    columnIds?: string[];
  };
}

function confirmedView(currentMetadata: SessionMetadata, viewContextId: string): ConfirmedProfileView {
  return {
    metadata: currentMetadata,
    view: {
      viewContextId,
      sessionId: currentMetadata.sessionId,
      revision: currentMetadata.revision
    }
  };
}

function valuesResponse(viewRequestId: string, value: string): ValuesResponse {
  return {
    kind: "columnValues",
    revision: metadata.revision,
    viewRequestId,
    column: "city",
    values: [{ value, count: 1 }],
    hasMore: false
  };
}

function emptyStats() {
  return {
    missingCells: 0,
    missingRows: 0,
    duplicateRows: 0,
    missingValuesByColumn: []
  };
}

function runtimeEnvelopes(kind: string): RuntimeEnvelope[] {
  return postMessage.mock.calls
    .map(([message]) => message as RuntimeEnvelope)
    .filter((message) => message.kind === "runtimeRequest" && message.request.kind === kind);
}

function onlyRuntimeEnvelope(kind: string): RuntimeEnvelope {
  const messages = runtimeEnvelopes(kind);
  expect(messages).toHaveLength(1);
  return messages[0]!;
}

function prioritizedRequestIds(): string[] {
  return postMessage.mock.calls
    .map(([message]) => message as { kind: string; viewRequestId?: string })
    .filter((message) => message.kind === "prioritizeViewRequest" && message.viewRequestId !== undefined)
    .map((message) => message.viewRequestId!);
}

function cancelledRequestIds(): string[] {
  return postMessage.mock.calls
    .map(([message]) => message as { kind: string; viewRequestIds?: string[] })
    .filter((message) => message.kind === "cancelViewRequests")
    .flatMap((message) => message.viewRequestIds ?? []);
}
