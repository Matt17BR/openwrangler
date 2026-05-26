export const DATA_EXPLORER_MIME = "application/vnd.data-explorer.viewer.v1+json";

export interface NotebookOutputPayload {
  metadata: unknown;
  page: unknown;
  summaries: unknown;
}

export const isNotebookOutputPayload = (value: unknown): value is NotebookOutputPayload => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "metadata" in value && "page" in value && "summaries" in value;
};
