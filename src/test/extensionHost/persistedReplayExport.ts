import type { DataBackend, ExportDataRequest } from "../../shared/protocol";

export interface PersistedReplayExportTarget {
  readonly backend: DataBackend;
  readonly sessionId: string;
  readonly revision: number;
}

export function persistedReplayExportRequest(
  target: PersistedReplayExportTarget,
  path: string,
  format: ExportDataRequest["format"]
): ExportDataRequest {
  return {
    kind: "exportData",
    sessionId: target.sessionId,
    revision: target.revision,
    path,
    format,
    ...(target.backend === "pandas" ? { rowAxisPolicy: "omit" as const } : {})
  };
}
