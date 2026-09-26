import { describe, expect, it } from "vitest";
import type { FilterModel, LiveGridPage, SessionMetadata } from "../shared/protocol";
import { isOpenWranglerResponse } from "../shared/protocolValidation";
import {
  alignedColumnWindow,
  backgroundDiagnosticKey,
  cloneBackgroundDiagnostics,
  columnWindowFromPage,
  decodeAppHostMessage,
  filterModelForColumnValues,
  isSessionOpenProgressStage,
  isSwitchableFileBackend,
  pageCoversColumnWindow,
  sameFilterModel,
  sameFilterRules,
  sameSortRules,
  sessionOpenProgressHeading,
  withoutDatasetStats,
  type BackgroundDiagnostic
} from "../webviews/appState";
import { metadata } from "./filterSummary.testFixtures";

const page: LiveGridPage = {
  offset: 0,
  limit: 4,
  totalRows: 4,
  columnIds: ["c:0", "c:1"],
  rows: []
};

const cityFilter = {
  column: "city",
  type: "string" as const,
  predicates: [{ kind: "predicate" as const, operator: "equals" as const, value: "Berlin" }]
};

const salesFilter = {
  column: "sales",
  type: "float" as const,
  predicates: [{ kind: "predicate" as const, operator: "gt" as const, value: 10 }]
};

const filtered: FilterModel = {
  logic: "and",
  filters: [cityFilter, salesFilter],
  sort: [{ column: "sales", direction: "desc", nulls: "last" }]
};

describe("App view-state model", () => {
  it("requires the displayed session and revision for a native Dataset action", () => {
    const action = {
      kind: "editorAction",
      action: "openDatasetSummary",
      expectedSessionId: "session",
      expectedRevision: 3
    };
    expect(decodeAppHostMessage(action)).toEqual(action);
    for (const expectedSessionId of [undefined, null, 4, ""]) {
      expect(decodeAppHostMessage({ ...action, expectedSessionId })).toBeUndefined();
    }
    for (const expectedRevision of [undefined, null, -1, 0.5, "3"]) {
      expect(decodeAppHostMessage({ ...action, expectedRevision })).toBeUndefined();
    }
  });

  it("accepts a bounded import activity only as text", () => {
    const busy = { kind: "importOptionsState", busy: true };
    expect(decodeAppHostMessage(busy)).toEqual(busy);
    expect(decodeAppHostMessage({ ...busy, activity: "Switching to R · dplyr…" })).toEqual({
      ...busy,
      activity: "Switching to R · dplyr…"
    });
    expect(decodeAppHostMessage({ ...busy, activity: "x".repeat(200) })).toBeDefined();
    for (const activity of ["x".repeat(201), 1, null]) {
      expect(decodeAppHostMessage({ ...busy, activity })).toBeUndefined();
    }
    const switching = { ...busy, activity: "Switching to R · dplyr…" };
    expect(decodeAppHostMessage({ ...switching, pendingEngine: "R · dplyr" })).toEqual({
      ...switching,
      pendingEngine: "R · dplyr"
    });
    expect(decodeAppHostMessage({ ...switching, pendingEngine: "x".repeat(64) })).toBeDefined();
    for (const pendingEngine of ["", "x".repeat(65), 1, null]) {
      expect(decodeAppHostMessage({ ...switching, pendingEngine })).toBeUndefined();
    }
    expect(decodeAppHostMessage({ ...busy, pendingEngine: "R · dplyr" })).toBeUndefined();
  });

  it("requires bound native filter removal fields", () => {
    const action = {
      kind: "editorAction",
      action: "clearFilterColumn",
      column: "city",
      expectedSessionId: "session",
      expectedFilterSignature: JSON.stringify([cityFilter])
    };
    expect(decodeAppHostMessage(action)).toEqual(action);
    for (const field of ["column", "expectedSessionId", "expectedFilterSignature"] as const) {
      for (const invalid of [undefined, null, 1, ""]) {
        expect(decodeAppHostMessage({ ...action, [field]: invalid })).toBeUndefined();
      }
    }
    expect(decodeAppHostMessage({ kind: "editorAction", action: "clearFilterColumn", column: "city" })).toBeUndefined();
  });

  it("decodes the Redo editor action with checked session and revision fields", () => {
    const action = { kind: "editorAction", action: "redoStep", expectedSessionId: "session", expectedRevision: 3 };
    expect(decodeAppHostMessage(action)).toEqual(action);
    expect(decodeAppHostMessage({ ...action, expectedRevision: -1 })).toBeUndefined();
    expect(decodeAppHostMessage({ ...action, expectedSessionId: 4 })).toBeUndefined();
  });

  it("requires a strictly checked host snapshot offer without changing native snapshots", () => {
    const snapshot = { kind: "sessionOpened", metadata, page, summaries: [] };
    const offered = { ...snapshot, offeredViewContextId: "snapshot:accepted" };
    expect(decodeAppHostMessage(offered)).toEqual(offered);
    expect(decodeAppHostMessage(snapshot)).toBeUndefined();
    for (const offeredViewContextId of [
      undefined,
      null,
      1,
      "",
      "snapshot:",
      "other:accepted",
      "snapshot:two words",
      "snapshot:".padEnd(257, "x")
    ]) {
      expect(decodeAppHostMessage({ ...snapshot, offeredViewContextId })).toBeUndefined();
    }
  });

  it("rejects forged PySpark metadata with an editing file source", () => {
    expect(
      decodeAppHostMessage({
        kind: "sessionOpened",
        offeredViewContextId: "snapshot:invalid-backend",
        metadata: { ...metadata, backend: "pyspark" },
        page,
        summaries: []
      })
    ).toBeUndefined();
  });

  it.each(["sessionOpened", "stepPreview", "planUpdated"])(
    "decodes atomic %s view state without accepting host extras in native responses",
    (kind) => {
      const response = {
        kind,
        metadata,
        page,
        ...(kind === "sessionOpened"
          ? { summaries: [] }
          : {
              revision: metadata.revision,
              code: "frame",
              ...(kind === "planUpdated"
                ? { action: "apply" }
                : {
                    diff: {
                      addedRows: 0,
                      removedRows: 0,
                      addedColumns: [],
                      removedColumns: [],
                      changedCells: 0,
                      cells: [],
                      truncated: false
                    }
                  })
            })
      };
      expect(isOpenWranglerResponse(response)).toBe(true);
      const packet = {
        ...response,
        ...(kind === "sessionOpened" ? { offeredViewContextId: "snapshot:atomic" } : {}),
        viewState: {
          columnWidths: [["c:1", 240]],
          selectedColumnId: "c:1",
          viewport: { firstVisibleRow: 2, scrollLeft: 80 }
        }
      };
      const original = JSON.stringify(packet);
      expect(isOpenWranglerResponse(packet)).toBe(false);
      expect(decodeAppHostMessage(packet)).toEqual({
        ...packet,
        viewState: { ...packet.viewState, columnWidths: new Map([["c:1", 240]]) }
      });
      expect(JSON.stringify(packet)).toBe(original);
      for (const viewState of [
        undefined,
        null,
        { ...packet.viewState, columnWidths: [["c:1", -1]] },
        { ...packet.viewState, viewport: { firstVisibleRow: -1, scrollLeft: 0 } }
      ]) {
        expect(decodeAppHostMessage({ ...packet, viewState })).toBeUndefined();
      }
      expect(decodeAppHostMessage({ ...packet, unexpected: true })).toBeUndefined();
      expect(
        decodeAppHostMessage({
          ...packet,
          metadata: { ...metadata, schema: metadata.schema.map((column) => ({ ...column, position: 8 })) }
        })
      ).toBeUndefined();
    }
  );

  it("binds an atomic snapshot presentation to its confirmed revision and draft", () => {
    const draftStep = { id: "upper-city", kind: "upperText", params: { column: { id: "c:0", name: "city" } } };
    const presentation = {
      sessionId: metadata.sessionId,
      revision: metadata.revision,
      draft: {
        diff: {
          addedRows: 0,
          removedRows: 0,
          addedColumns: [],
          removedColumns: [],
          changedCells: 0,
          cells: [],
          truncated: false
        },
        warnings: ["Review the restored draft."],
        beforeSchema: metadata.schema
      }
    };
    const packet = {
      kind: "sessionOpened",
      offeredViewContextId: "snapshot:draft",
      metadata: { ...metadata, draftStep },
      page,
      summaries: [],
      presentation
    };
    expect(decodeAppHostMessage(packet)).toEqual(packet);
    for (const invalid of [
      undefined,
      null,
      { ...presentation, sessionId: "other" },
      { ...presentation, revision: metadata.revision + 1 },
      { ...presentation, draft: undefined },
      { ...presentation, draft: { ...presentation.draft, warnings: [false] } },
      { ...presentation, code: "unexpected private code" }
    ]) {
      expect(decodeAppHostMessage({ ...packet, presentation: invalid })).toBeUndefined();
    }
    expect(decodeAppHostMessage({ ...packet, metadata })).toBeUndefined();
  });

  it("decodes one authoritative recovery payload and rejects mixed ownership or duplicate pages", () => {
    const packet = {
      kind: "sessionRecovered",
      offeredViewContextId: "recovery:accepted",
      context: {
        sessionId: metadata.sessionId,
        revision: metadata.revision,
        viewContextId: "previous",
        lastPageRequestId: null,
        request: null
      },
      snapshot: { kind: "sessionOpened", metadata, page, summaries: [] },
      presentation: { sessionId: metadata.sessionId, revision: metadata.revision },
      viewState: { columnWidths: [["c:0", 100]], viewport: { firstVisibleRow: 0, scrollLeft: 0 } }
    };
    const original = JSON.stringify(packet);
    expect(decodeAppHostMessage(packet)).toEqual({
      ...packet,
      viewState: { ...packet.viewState, columnWidths: new Map([["c:0", 100]]) }
    });
    expect(JSON.stringify(packet)).toBe(original);
    expect(decodeAppHostMessage({ ...packet, offeredViewContextId: "recovery:".padEnd(256, "x") })?.kind).toBe(
      "sessionRecovered"
    );
    for (const invalid of [
      { ...packet, offeredViewContextId: "ordinary-view" },
      { ...packet, offeredViewContextId: "recovery:" },
      { ...packet, offeredViewContextId: "recovery: " },
      { ...packet, offeredViewContextId: "recovery:".padEnd(257, "x") },
      { ...packet, context: { ...packet.context, viewContextId: "v".repeat(257) } },
      { ...packet, context: { ...packet.context, lastPageRequestId: "v".repeat(257) } },
      { ...packet, result: undefined },
      { ...packet, snapshot: undefined },
      { ...packet, context: { ...packet.context, sessionId: "other" } },
      { ...packet, context: { ...packet.context, lastPageRequestId: 12 } },
      { ...packet, presentation: { ...packet.presentation, revision: metadata.revision + 1 } },
      { ...packet, viewState: { ...packet.viewState, columnWidths: [["c:0", -1]] } },
      { ...packet, snapshot: { ...packet.snapshot, metadata: { ...metadata, backend: "pyspark" } } },
      { ...packet, result: { kind: "error", code: "native", message: "A native caller's error", recoverable: true } },
      { ...packet, result: { kind: "page", revision: metadata.revision, viewRequestId: "page-1", metadata, page } }
    ])
      expect(decodeAppHostMessage(invalid)).toBeUndefined();

    const failed = {
      ...packet,
      context: {
        ...packet.context,
        lastPageRequestId: "page-1",
        request: { kind: "getPage", viewRequestId: "page-1" }
      },
      result: {
        kind: "error",
        code: "page_failed",
        message: "The request failed",
        recoverable: true,
        viewRequestId: "page-1"
      }
    };
    expect(decodeAppHostMessage(failed)?.kind).toBe("sessionRecovered");
    const oversizedId = "v".repeat(257);
    expect(
      decodeAppHostMessage({
        ...failed,
        context: {
          ...failed.context,
          lastPageRequestId: oversizedId,
          request: { kind: "getPage", viewRequestId: oversizedId }
        },
        result: { ...failed.result, viewRequestId: oversizedId }
      })
    ).toBeUndefined();
    expect(decodeAppHostMessage({ ...failed, result: { ...failed.result, viewRequestId: "older" } })).toBeUndefined();
    expect(decodeAppHostMessage({ ...failed, result: { ...failed.result, sessionId: "other" } })).toBeUndefined();
    expect(decodeAppHostMessage({ ...failed, result: { ...failed.result, revision: -1 } })).toBeUndefined();
    expect(
      decodeAppHostMessage({
        ...failed,
        result: { kind: "error", code: "page_failed", message: "Missing correlation", recoverable: true }
      })
    ).toBeUndefined();
    expect(
      decodeAppHostMessage({ ...failed, context: { ...failed.context, request: { kind: "generateCode" } } })
    ).toBeUndefined();
    const { snapshot: _snapshot, ...withoutSnapshot } = failed;
    const succeeded = {
      ...withoutSnapshot,
      result: { kind: "page", revision: metadata.revision, metadata, page, viewRequestId: "page-1" }
    };
    expect(decodeAppHostMessage(succeeded)?.kind).toBe("sessionRecovered");
    expect(
      decodeAppHostMessage({ ...succeeded, result: { ...succeeded.result, revision: metadata.revision + 1 } })
    ).toBeUndefined();
    expect(
      decodeAppHostMessage({ ...succeeded, context: { ...succeeded.context, request: { kind: "previewStep" } } })
    ).toBeUndefined();
  });

  it("clones background diagnostics without sharing mutable summary owners", () => {
    const summary: BackgroundDiagnostic = {
      message: "summary failed",
      pending: {
        kind: "summary",
        viewContextId: "view-a",
        columnId: "c:0",
        attempt: 2,
        owners: new Set(["grid"])
      }
    };
    const diagnostics = new Map<string, BackgroundDiagnostic>([["summary:c:0", summary]]);
    const cloned = cloneBackgroundDiagnostics(diagnostics);
    const clonedSummary = cloned.get("summary:c:0");

    expect(cloned).not.toBe(diagnostics);
    expect(clonedSummary).toEqual(summary);
    expect(clonedSummary).not.toBe(summary);
    expect(clonedSummary?.pending).not.toBe(summary.pending);
    expect(clonedSummary?.pending.kind).toBe("summary");
    if (clonedSummary?.pending.kind !== "summary") throw new Error("Expected a cloned summary diagnostic.");
    clonedSummary.pending.owners.add("drawer");
    expect(summary.pending.kind === "summary" && [...summary.pending.owners]).toEqual(["grid"]);

    expect(backgroundDiagnosticKey(summary.pending)).toBe("summary:c:0");
    expect(backgroundDiagnosticKey({ kind: "stats", viewContextId: "view-a", attempt: 1 })).toBe("stats");
    expect(backgroundDiagnosticKey({ kind: "values", viewContextId: "view-a", column: "city" })).toBe("values:city");
  });

  it("compares filter and sort ownership independently and removes only the requested values filter", () => {
    const equivalent: FilterModel = { ...filtered, logic: undefined };
    const changedFilter: FilterModel = {
      ...filtered,
      filters: [{ ...cityFilter, predicates: [{ kind: "predicate", operator: "equals", value: "Paris" }] }]
    };
    const changedSort: FilterModel = {
      ...filtered,
      sort: [{ column: "sales", direction: "asc", nulls: "last" }]
    };

    expect(sameFilterModel(filtered, equivalent)).toBe(true);
    expect(sameFilterRules(filtered, changedSort)).toBe(true);
    expect(sameSortRules(filtered, changedFilter)).toBe(true);
    expect(sameFilterRules(filtered, changedFilter)).toBe(false);
    expect(sameSortRules(filtered, changedSort)).toBe(false);
    expect(filterModelForColumnValues(filtered, "city")).toEqual({
      ...filtered,
      filters: [salesFilter]
    });
  });

  it("derives and verifies bounded column windows from stable column IDs", () => {
    expect(alignedColumnWindow({ start: 250, end: 270 }, 1_000, 256)).toEqual({ offset: 250, limit: 256 });
    expect(alignedColumnWindow({ start: 0, end: 1 }, 0, 0)).toEqual({ offset: 0, limit: 1 });
    expect(columnWindowFromPage(metadata, page, { offset: 1, limit: 1 })).toEqual({ offset: 0, limit: 2 });
    expect(columnWindowFromPage(metadata, { ...page, columnIds: ["unknown"] }, { offset: 99, limit: 999 })).toEqual({
      offset: 1,
      limit: 256
    });
    expect(pageCoversColumnWindow(metadata, page, { offset: 0, limit: 2 })).toBe(true);
    expect(pageCoversColumnWindow(metadata, { ...page, columnIds: ["c:1", "c:0"] }, { offset: 0, limit: 2 })).toBe(
      false
    );

    const emptyMetadata: SessionMetadata = {
      ...metadata,
      shape: { rows: 4, columns: 0 },
      filteredShape: { rows: 4, columns: 0 },
      schema: []
    };
    expect(columnWindowFromPage(emptyMetadata, { ...page, columnIds: [] }, { offset: 8, limit: 0 })).toEqual({
      offset: 0,
      limit: 1
    });
    expect(pageCoversColumnWindow(emptyMetadata, { ...page, columnIds: [] }, { offset: 0, limit: 1 })).toBe(true);
  });

  it("keeps metadata stripping, backend switching, and progress decoding exact", () => {
    expect(withoutDatasetStats(metadata)).toEqual(expect.not.objectContaining({ stats: expect.anything() }));
    expect(metadata.stats).toBeDefined();
    expect(["pandas", "polars", "duckdb", "r"].every((backend) => isSwitchableFileBackend(backend as "pandas"))).toBe(
      true
    );
    expect(isSwitchableFileBackend("pyspark")).toBe(false);

    expect(isSessionOpenProgressStage("acquiringKernel")).toBe(true);
    expect(isSessionOpenProgressStage("preparingSparkView")).toBe(true);
    expect(isSessionOpenProgressStage("preparing-spark-view")).toBe(false);
    expect(sessionOpenProgressHeading("acquiringKernel")).toBe("Connecting to the notebook kernel…");
    expect(sessionOpenProgressHeading("preparingSparkView")).toBe("Preparing PySpark 4.2 (viewing only)…");
  });
});
