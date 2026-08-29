import { describe, expect, it } from "vitest";
import type { FilterModel, LiveGridPage, SessionMetadata } from "../shared/protocol";
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
  it("rejects forged PySpark metadata with an editing file source", () => {
    expect(
      decodeAppHostMessage({
        kind: "sessionOpened",
        metadata: { ...metadata, backend: "pyspark" },
        page,
        summaries: []
      })
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
    expect(["pandas", "polars", "duckdb"].every((backend) => isSwitchableFileBackend(backend as "pandas"))).toBe(true);
    expect(isSwitchableFileBackend("pyspark")).toBe(false);
    expect(isSwitchableFileBackend("r")).toBe(false);

    expect(isSessionOpenProgressStage("acquiringKernel")).toBe(true);
    expect(isSessionOpenProgressStage("preparingSparkView")).toBe(true);
    expect(isSessionOpenProgressStage("preparing-spark-view")).toBe(false);
    expect(sessionOpenProgressHeading("acquiringKernel")).toBe("Connecting to the notebook kernel…");
    expect(sessionOpenProgressHeading("preparingSparkView")).toBe("Preparing PySpark 4.2 (viewing only)…");
  });
});
