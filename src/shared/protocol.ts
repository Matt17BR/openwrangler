import type { ColumnType, FilterModel } from "./filterModel";

export type DataBackend = "polars" | "pandas";

export type SessionSourceKind = "file" | "notebookVariable" | "notebookOutput";

export interface SessionSource {
  kind: SessionSourceKind;
  label: string;
  path?: string;
  variableName?: string;
}

export interface ColumnSchema {
  name: string;
  rawType: string;
  type: ColumnType;
  nullable: boolean;
}

export interface DataShape {
  rows: number;
  columns: number;
}

export interface CellValue {
  raw: unknown;
  display: string;
  isNull: boolean;
  isNaN: boolean;
}

export interface DataRow {
  rowNumber: number;
  values: CellValue[];
}

export interface GridPage {
  offset: number;
  limit: number;
  totalRows: number;
  rows: DataRow[];
}

export interface ValueCount {
  value: string;
  count: number;
}

export interface NumericSummary {
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  std?: number;
}

export interface ColumnSummary {
  column: string;
  type: ColumnType;
  rawType: string;
  totalCount: number;
  nullCount: number;
  nanCount: number;
  distinctCount?: number;
  numeric?: NumericSummary;
  topValues: ValueCount[];
}

export interface SessionMetadata {
  sessionId: string;
  backend: DataBackend;
  source: SessionSource;
  shape: DataShape;
  filteredShape: DataShape;
  schema: ColumnSchema[];
  filterModel: FilterModel;
}

export interface OpenSessionRequest {
  kind: "openSession";
  source: SessionSource;
  backend?: DataBackend;
  pageSize: number;
}

export interface PageRequest {
  kind: "getPage";
  sessionId: string;
  offset: number;
  limit: number;
  filterModel: FilterModel;
}

export interface SummaryRequest {
  kind: "getSummary";
  sessionId: string;
  filterModel: FilterModel;
  columns?: string[];
}

export interface ValuesRequest {
  kind: "getColumnValues";
  sessionId: string;
  column: string;
  filterModel: FilterModel;
  search?: string;
  limit: number;
}

export type DataExplorerRequest = OpenSessionRequest | PageRequest | SummaryRequest | ValuesRequest;

export interface SessionOpenedResponse {
  kind: "sessionOpened";
  metadata: SessionMetadata;
  page: GridPage;
  summaries: ColumnSummary[];
}

export interface PageResponse {
  kind: "page";
  page: GridPage;
  metadata: SessionMetadata;
}

export interface SummaryResponse {
  kind: "summary";
  summaries: ColumnSummary[];
}

export interface ValuesResponse {
  kind: "columnValues";
  column: string;
  values: ValueCount[];
  hasMore: boolean;
}

export interface ErrorResponse {
  kind: "error";
  message: string;
  detail?: string;
}

export type DataExplorerResponse =
  | SessionOpenedResponse
  | PageResponse
  | SummaryResponse
  | ValuesResponse
  | ErrorResponse;
