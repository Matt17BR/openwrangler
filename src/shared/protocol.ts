export * from "./protocol.generated";

import type {
  ColumnVisualization,
  DataBackend,
  DatasetStats,
  GridPage,
  LiveGridPage,
  OpenWranglerRequest,
  SessionSource,
  SourceCapabilities,
  TypedCellKind
} from "./protocol.generated";

export const PROTOCOL_VERSION = 2 as const;

export type SessionSourceKind = SessionSource["kind"];
export type NumericVisualization = Extract<ColumnVisualization, { kind: "numeric" }>;
export type CategoricalVisualization = Extract<ColumnVisualization, { kind: "categorical" }>;
export type BooleanVisualization = Extract<ColumnVisualization, { kind: "boolean" }>;
export type DatetimeVisualization = Extract<ColumnVisualization, { kind: "datetime" }>;
export type MissingValueByColumn = DatasetStats["missingValuesByColumn"][number];
export type SessionBoundRequest = Extract<OpenWranglerRequest, { sessionId: string }>;
export type OptionalViewingCapability = "filter" | "sort" | "profile" | "columnValues";

/** Optional viewing capabilities default to supported for protocol-v2 compatibility. */
export function supportsViewingCapability(
  capabilities: SourceCapabilities | undefined,
  capability: OptionalViewingCapability
): boolean {
  return capabilities?.[capability] !== false;
}

export function dataBackendLabel(backend: DataBackend): string {
  switch (backend) {
    case "polars":
      return "Polars";
    case "duckdb":
      return "DuckDB";
    case "pandas":
      return "Pandas";
    case "pyspark":
      return "PySpark";
    case "r":
      return "R";
  }
}

export function isSessionBoundRequest(request: OpenWranglerRequest): request is SessionBoundRequest {
  return "sessionId" in request;
}

export function isExactRowCount(value: number | null): value is number {
  return value !== null;
}

export function liveGridPageHasMore(page: LiveGridPage): boolean {
  return page.totalRows === null ? page.hasMore : page.offset + page.rows.length < page.totalRows;
}

export function isExactGridPage(page: LiveGridPage): page is GridPage {
  return page.totalRows !== null;
}

/**
 * Return the finite virtual-scroll runway for a live page without presenting it
 * as an exact dataset count. Unknown Spark pages expose only one additional
 * block, so the user can move forward progressively without an unbounded fake
 * scrollbar.
 */
export function liveGridLogicalRowExtent(page: LiveGridPage): number {
  if (page.totalRows !== null) return page.totalRows;
  return Math.min(Number.MAX_SAFE_INTEGER, page.offset + page.rows.length + page.limit);
}

export function formatSessionRowCount(rows: number | null): string {
  return rows === null ? "Not counted" : rows.toLocaleString();
}

export function typedCellKind(value: unknown, isNull: boolean, isNaN: boolean): TypedCellKind {
  if (isNull) return "null";
  if (isNaN) return "nan";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  return "unknown";
}
