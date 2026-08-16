import * as assert from "node:assert/strict";
import type { GridPage } from "../../shared/protocol";
import { codePreviewDocumentReceipt } from "./playwrightLifecycle";
import type { TestApi } from "./extensionHostTestApi";

export interface ReleasedRPageBoundaryDependencies {
  readonly GRID_COLUMN_WINDOW: Readonly<{ columnOffset: number; columnLimit: number }>;
}

export function createReleasedRPageBoundary(dependencies: ReleasedRPageBoundaryDependencies): Readonly<{
  releasedRVisibleRows: (
    testing: TestApi,
    sessionId: string,
    requestId: string,
    limit: number
  ) => Promise<GridPage["rows"]>;
  releasedRFirstVisibleRow: (
    testing: TestApi,
    sessionId: string,
    requestId: string
  ) => Promise<GridPage["rows"][number]>;
}> {
  const { GRID_COLUMN_WINDOW } = dependencies;

  async function releasedRVisibleRows(
    testing: TestApi,
    sessionId: string,
    requestId: string,
    limit: number
  ): Promise<GridPage["rows"]> {
    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "The native R row check must retain its exact session.");
    assert.ok(active, "The native R row check requires one active session.");
    const response = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: active.metadata.revision,
      viewRequestId: requestId,
      offset: 0,
      limit,
      filterModel: active.viewState.filterModel
    });
    assert.equal(response.kind, "page");
    if (response.kind !== "page") throw new Error("The native R row request did not return a page.");
    return response.page.rows;
  }

  async function releasedRFirstVisibleRow(
    testing: TestApi,
    sessionId: string,
    requestId: string
  ): Promise<GridPage["rows"][number]> {
    const active = testing.activeSession();
    assert.equal(active?.sessionId, sessionId, "The native R row check must retain its exact session.");
    assert.ok(active, "The native R row check requires one active session.");
    const response = await testing.request({
      kind: "getPage",
      ...GRID_COLUMN_WINDOW,
      sessionId,
      revision: active.metadata.revision,
      viewRequestId: requestId,
      offset: 0,
      limit: 1,
      filterModel: active.viewState.filterModel
    });
    if (response.kind !== "page") {
      const diagnostic = {
        kind: response.kind,
        code: response.kind === "error" ? response.code : null,
        recoverable: response.kind === "error" ? response.recoverable : null,
        viewRequestId:
          "viewRequestId" in response && typeof response.viewRequestId === "string" ? response.viewRequestId : null,
        messageReceipt: response.kind === "error" ? codePreviewDocumentReceipt(response.message) : null
      };
      assert.fail(`The native R first-row request did not return a page: ${JSON.stringify(diagnostic)}.`);
    }
    if (response.kind !== "page") throw new Error("The native R first-row request did not return a page.");
    const row = response.page.rows[0];
    assert.ok(row, "The native R first-row request must return one row.");
    return row;
  }

  return Object.freeze({ releasedRVisibleRows, releasedRFirstVisibleRow });
}
