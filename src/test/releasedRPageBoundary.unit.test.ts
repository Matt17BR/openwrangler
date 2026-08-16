import { describe, expect, it, vi } from "vitest";
import type { OpenWranglerResponse } from "../shared/protocol";
import type { TestApi } from "./extensionHost/extensionHostTestApi";
import { createReleasedRPageBoundary } from "./extensionHost/releasedRPageBoundary";

const filterModel = { filters: [], sort: [] } as const;
const row = {
  rowId: "row-1",
  values: [{ kind: "integer", raw: "1", display: "1", isNull: false, isNaN: false }]
} as const;

function fakeTesting(response: unknown, sessionId = "session-r") {
  const request = vi.fn(async () => response as OpenWranglerResponse);
  const testing = {
    activeSession: () => ({
      sessionId,
      metadata: { revision: 17 },
      viewState: { filterModel }
    }),
    request
  } as unknown as TestApi;
  return { request, testing };
}

const boundary = createReleasedRPageBoundary({
  GRID_COLUMN_WINDOW: { columnOffset: 3, columnLimit: 5 }
});

describe("released R page boundary", () => {
  it("requests and returns the exact visible row window", async () => {
    const { request, testing } = fakeTesting({
      kind: "page",
      sessionId: "session-r",
      revision: 17,
      viewRequestId: "visible-rows",
      page: { offset: 0, limit: 2, totalRows: 1, columnIds: ["column-1"], rows: [row] }
    });

    await expect(boundary.releasedRVisibleRows(testing, "session-r", "visible-rows", 2)).resolves.toEqual([row]);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      kind: "getPage",
      columnOffset: 3,
      columnLimit: 5,
      sessionId: "session-r",
      revision: 17,
      viewRequestId: "visible-rows",
      offset: 0,
      limit: 2,
      filterModel
    });
  });

  it("returns the first row from its exact one-row request", async () => {
    const { request, testing } = fakeTesting({
      kind: "page",
      sessionId: "session-r",
      revision: 17,
      viewRequestId: "first-row",
      page: { offset: 0, limit: 1, totalRows: 1, columnIds: ["column-1"], rows: [row] }
    });

    await expect(boundary.releasedRFirstVisibleRow(testing, "session-r", "first-row")).resolves.toEqual(row);
    expect(request).toHaveBeenCalledExactlyOnceWith({
      kind: "getPage",
      columnOffset: 3,
      columnLimit: 5,
      sessionId: "session-r",
      revision: 17,
      viewRequestId: "first-row",
      offset: 0,
      limit: 1,
      filterModel
    });
  });

  it("fails before dispatch when the active session differs", async () => {
    const { request, testing } = fakeTesting({ kind: "disposed", sessionId: "other" }, "other");

    await expect(boundary.releasedRVisibleRows(testing, "session-r", "stale", 1)).rejects.toThrow(
      /retain its exact session/u
    );
    await expect(boundary.releasedRFirstVisibleRow(testing, "session-r", "stale")).rejects.toThrow(
      /retain its exact session/u
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("reports bounded error metadata without retaining the full message", async () => {
    const secretTail = "private-detail-".repeat(200);
    const { testing } = fakeTesting({
      kind: "error",
      sessionId: "session-r",
      code: "runtime_error",
      message: `R page failed ${secretTail}`,
      recoverable: true,
      viewRequestId: "first-error"
    });

    const failure = await boundary
      .releasedRFirstVisibleRow(testing, "session-r", "first-error")
      .catch((error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('"code":"runtime_error"');
    expect(String(failure)).toContain('"recoverable":true');
    expect(String(failure)).toContain('"viewRequestId":"first-error"');
    expect(String(failure)).not.toContain(secretTail);
  });

  it("rejects an empty successful first page", async () => {
    const { testing } = fakeTesting({
      kind: "page",
      sessionId: "session-r",
      revision: 17,
      viewRequestId: "empty",
      page: { offset: 0, limit: 1, totalRows: 0, columnIds: ["column-1"], rows: [] }
    });

    await expect(boundary.releasedRFirstVisibleRow(testing, "session-r", "empty")).rejects.toThrow(
      /must return one row/u
    );
  });
});
