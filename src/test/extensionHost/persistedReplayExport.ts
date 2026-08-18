import type { DataBackend, ExportDataRequest } from "../../shared/protocol";

export interface PersistedReplayExportTarget {
  readonly backend: DataBackend;
  readonly sessionId: string;
  readonly revision: number;
}

export function persistedReplayExportRequest(
  target: PersistedReplayExportTarget,
  path: string,
  format: ExportDataRequest["options"]["format"]
): ExportDataRequest {
  const rowAxisPolicy = target.backend === "pandas" ? { rowAxisPolicy: "omit" as const } : {};
  return {
    kind: "exportData",
    sessionId: target.sessionId,
    revision: target.revision,
    path,
    options:
      format === "csv"
        ? { format, delimiter: ",", quoteChar: '"', encoding: "utf-8", header: true, ...rowAxisPolicy }
        : { format, ...rowAxisPolicy }
  };
}
