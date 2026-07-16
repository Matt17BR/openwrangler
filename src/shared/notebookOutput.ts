import type { ColumnSummary, GridPage, SessionMetadata, SessionOpenedResponse } from "./protocol";
import { isOpenWranglerResponse } from "./protocolValidation";

export const OPEN_WRANGLER_MIME_V2 = "application/vnd.openwrangler.viewer.v2+json";

export interface NotebookOutputPayload {
  mimeVersion: 2;
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}

export function normalizeNotebookOutputPayload(value: unknown): NotebookOutputPayload | undefined {
  if (!isRecord(value) || value.mimeVersion !== 2) return undefined;
  const opened = {
    kind: "sessionOpened",
    metadata: value.metadata,
    page: value.page,
    summaries: value.summaries
  };
  if (!isOpenWranglerResponse(opened) || opened.kind !== "sessionOpened") return undefined;
  return {
    mimeVersion: 2,
    metadata: opened.metadata,
    page: opened.page,
    summaries: opened.summaries
  };
}

export function notebookPayloadAsOpened(payload: NotebookOutputPayload): SessionOpenedResponse {
  return { kind: "sessionOpened", metadata: payload.metadata, page: payload.page, summaries: payload.summaries };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
