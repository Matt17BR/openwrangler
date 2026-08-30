import type {
  CellValue,
  ColumnReference,
  ColumnSchema,
  ColumnSummary,
  DataDiff,
  ExportOptions,
  FilterModel,
  GridPage,
  LiveGridPage,
  OpenWranglerRequest,
  OpenWranglerResponse,
  RuntimeRequestEnvelope,
  RuntimeResponseEnvelope,
  RowAxis,
  SessionDataShape,
  SessionMetadata,
  TransformColumnFilter,
  TransformSortRule,
  TransformStep,
  TypedSelectionToken
} from "./protocol.generated";
import { openWranglerResponseShapes } from "./protocol.generated";
import { compareExactNumericExtremumCells, isExactNumericExtremumCell } from "./exactNumericExtrema";
import { isExactNumericSummaryCell, isExactNumericZeroCell } from "./numericSummary";
import { operationCatalog, type OperationCatalogItem } from "./operationCatalog.generated";
import { MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES } from "./protocolLimits.generated";
import {
  MAX_PIVOT_LONGER_COLUMNS,
  MIN_PIVOT_LONGER_COLUMNS,
  portablePivotLongerNameKey,
  validatePivotLongerOutputName
} from "./pivotLonger";
import {
  MAX_PIVOT_WIDER_OUTPUTS,
  MIN_PIVOT_WIDER_OUTPUTS,
  pivotWiderKeyValue,
  portablePivotWiderNameKey,
  validatePivotWiderOutputName
} from "./pivotWider";
import { portableRegexContract, validatePortableRegexOutputName } from "./portableRegex";
import { PROTOCOL_VERSION } from "./protocol";
import { hasAtMostViewValueTextCodePoints } from "./viewValueLimits";

type UnknownRecord = Record<string, unknown>;
type ValueGuard = (value: unknown) => boolean;

const COLUMN_TYPES = new Set([
  "string",
  "integer",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "struct",
  "unknown"
]);
const CELL_KINDS = new Set([
  "null",
  "nan",
  "infinity",
  "boolean",
  "number",
  "integer",
  "string",
  "decimal",
  "datetime",
  "date",
  "duration",
  "binary",
  "list",
  "struct",
  "unknown"
]);
const DATA_BACKENDS = ["polars", "duckdb", "pandas", "pyspark", "r"] as const;
const R_DATAFRAME_FLAVORS = ["r.data.frame", "r.tibble", "r.data.table"] as const;
const CANONICAL_SOURCE_URI = /^[a-z][a-z0-9+.-]*:(?:%[0-9A-Fa-f]{2}|[!#$&'()*+,\-./0-9:;=?@A-Z[\]_a-z~])+$/u;
const OPERATION_DEFINITIONS: ReadonlyMap<string, OperationCatalogItem> = new Map(
  operationCatalog.map((definition) => [definition.kind, definition])
);
const RESPONSE_SHAPES_BY_KIND: ReadonlyMap<string, (typeof openWranglerResponseShapes)[number]> = new Map(
  openWranglerResponseShapes.map((definition) => [definition.kind, definition] as const)
);
const PREDICATE_OPERATORS = new Set([
  "equals",
  "notEquals",
  "contains",
  "startsWith",
  "endsWith",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "isNull",
  "isNotNull",
  "isNaN",
  "isNotNaN"
]);
const CAST_DTYPES = new Set(["string", "integer", "float", "boolean", "date", "datetime"]);
const FORMULA_OPERATORS = new Set(["add", "subtract", "multiply", "divide", "modulo", "power"]);
const AGGREGATIONS = new Set(["sum", "mean", "min", "max", "median", "count", "nUnique", "first", "last"]);
const MAX_BY_EXAMPLE_SOURCE_COLUMNS = 16;
const MAX_BY_EXAMPLE_EXAMPLES = 64;
const MAX_BY_EXAMPLE_PROGRAM_NODES = 256;
const MAX_BY_EXAMPLE_PROGRAM_DEPTH = 64;
const MAX_BY_EXAMPLE_CONCAT_PARTS = 64;
const MAX_BY_EXAMPLE_WARNINGS = 64;
const MAX_BY_EXAMPLE_STRING_UTF8_BYTES = 8 * 1024;
const MAX_BY_EXAMPLE_TEXT_UTF8_BYTES = 64 * 1024;
const MAX_ROW_LABEL_CODE_POINTS = 1_024;

/** Validates the canonical protocol-v2 request envelope at an untrusted transport boundary. */
export function isRuntimeRequestEnvelope(value: unknown): value is RuntimeRequestEnvelope {
  const candidate = exactRecord(value, ["protocolVersion", "requestId", "priority", "request"]);
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(candidate.requestId) &&
    isOneOf(candidate.priority, ["interactive", "background"]) &&
    isOpenWranglerRequest(candidate.request)
  );
}

/** Validates every canonical protocol-v2 request variant and its structural payload. */
export function isOpenWranglerRequest(value: unknown): value is OpenWranglerRequest {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "initialize": {
      const candidate = exactRecord(value, ["kind"]);
      return candidate !== undefined && candidate.kind === "initialize";
    }
    case "openSession": {
      const candidate = exactRecord(
        value,
        ["kind", "source", "pageSize", "columnOffset", "columnLimit"],
        ["requestedSessionId", "cloneFrom", "backend", "mode"]
      );
      return (
        candidate !== undefined &&
        candidate.kind === "openSession" &&
        isSessionSource(candidate.source) &&
        optional(candidate, "requestedSessionId", isNonEmptyString) &&
        optional(candidate, "cloneFrom", isSessionCloneSource) &&
        (candidate.cloneFrom === undefined || candidate.requestedSessionId !== undefined) &&
        optional(candidate, "backend", (backend) => isOneOf(backend, DATA_BACKENDS)) &&
        (candidate.backend !== "pyspark" ||
          (isRecord(candidate.source) &&
            candidate.source.kind === "notebookVariable" &&
            (candidate.mode === undefined || candidate.mode === "viewing"))) &&
        (candidate.backend !== "r" ||
          (isRecord(candidate.source) &&
            (candidate.source.kind === "notebookVariable" ||
              candidate.source.kind === "documentVariable" ||
              candidate.source.kind === "rInteractiveVariable"))) &&
        (!isRecord(candidate.source) ||
          candidate.source.kind !== "rInteractiveVariable" ||
          candidate.backend === "r") &&
        optional(candidate, "mode", (mode) => isOneOf(mode, ["viewing", "editing"])) &&
        isBoundedPageSize(candidate.pageSize) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "getPage": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "viewRequestId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit",
        "filterModel"
      ]);
      return (
        isSessionRequest(candidate, "getPage") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit) &&
        isFilterModel(candidate.filterModel)
      );
    }
    case "getSummary": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "viewRequestId", "filterModel"],
        ["columnIds"]
      );
      return (
        isSessionRequest(candidate, "getSummary") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isFilterModel(candidate.filterModel) &&
        optional(candidate, "columnIds", (columnIds) => isUniqueNonEmptyStringArray(columnIds) && columnIds.length > 0)
      );
    }
    case "getDatasetStats": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision", "viewRequestId", "filterModel"]);
      return (
        isSessionRequest(candidate, "getDatasetStats") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isFilterModel(candidate.filterModel)
      );
    }
    case "getColumnValues": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "viewRequestId", "column", "filterModel", "limit"],
        ["search"]
      );
      return (
        isSessionRequest(candidate, "getColumnValues") &&
        isNonEmptyString(candidate.viewRequestId) &&
        isNonEmptyString(candidate.column) &&
        isFilterModel(candidate.filterModel) &&
        optional(candidate, "search", isString) &&
        isBoundedPageSize(candidate.limit)
      );
    }
    case "previewStep": {
      const candidate = exactRecord(
        value,
        ["kind", "sessionId", "revision", "step", "offset", "limit", "columnOffset", "columnLimit"],
        ["replaceStepId"]
      );
      return (
        isSessionRequest(candidate, "previewStep") &&
        isTransformStep(candidate.step) &&
        optional(candidate, "replaceStepId", isNonEmptyString) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "inspectStep": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "stepId",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit"
      ]);
      return (
        isSessionRequest(candidate, "inspectStep") &&
        isNonEmptyString(candidate.stepId) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "applyDraft":
    case "discardDraft":
    case "undoStep": {
      const candidate = exactRecord(value, [
        "kind",
        "sessionId",
        "revision",
        "offset",
        "limit",
        "columnOffset",
        "columnLimit"
      ]);
      return (
        isSessionRequest(candidate, value.kind) &&
        isNonNegativeInteger(candidate.offset) &&
        isBoundedPageSize(candidate.limit) &&
        isNonNegativeInteger(candidate.columnOffset) &&
        isBoundedColumnLimit(candidate.columnLimit)
      );
    }
    case "exportData": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision", "path", "options"], ["targetIdentity"]);
      return (
        isSessionRequest(candidate, "exportData") &&
        isNonEmptyString(candidate.path) &&
        isExportOptions(candidate.options) &&
        (candidate.targetIdentity === undefined || isExportTargetIdentity(candidate.targetIdentity))
      );
    }
    case "closeSession": {
      const candidate = exactRecord(value, ["kind", "sessionId", "revision"]);
      return isSessionRequest(candidate, "closeSession");
    }
    case "cancelRequest": {
      const candidate = exactRecord(value, ["kind", "targetRequestId"]);
      return (
        candidate !== undefined && candidate.kind === "cancelRequest" && isNonEmptyString(candidate.targetRequestId)
      );
    }
    default:
      return false;
  }
}

function isSessionCloneSource(value: unknown): boolean {
  const candidate = exactRecord(value, ["sessionId", "revision"]);
  return candidate !== undefined && isNonEmptyString(candidate.sessionId) && isNonNegativeInteger(candidate.revision);
}

export function isExportOptions(value: unknown): value is ExportOptions {
  if (!isRecord(value)) return false;
  if (value.format === "csv") {
    const candidate = exactRecord(value, ["format", "delimiter", "quoteChar", "encoding", "header"], ["rowAxisPolicy"]);
    return (
      candidate !== undefined &&
      isCsvSyntaxCharacter(candidate.delimiter) &&
      isCsvSyntaxCharacter(candidate.quoteChar) &&
      candidate.delimiter !== candidate.quoteChar &&
      isBoundedExportEncoding(candidate.encoding) &&
      isBoolean(candidate.header) &&
      optional(candidate, "rowAxisPolicy", (policy) => isOneOf(policy, ["preserve", "omit"]))
    );
  }
  if (value.format === "parquet") {
    const candidate = exactRecord(value, ["format"], ["rowAxisPolicy"]);
    return (
      candidate !== undefined && optional(candidate, "rowAxisPolicy", (policy) => isOneOf(policy, ["preserve", "omit"]))
    );
  }
  return false;
}

function isExportTargetIdentity(value: unknown): boolean {
  const candidate = exactRecord(value, ["device", "inode"]);
  return (
    candidate !== undefined &&
    isCanonicalUnsigned128BitDecimal(candidate.device) &&
    isCanonicalUnsigned128BitDecimal(candidate.inode) &&
    (candidate.device !== "0" || candidate.inode !== "0")
  );
}

function isCanonicalUnsigned128BitDecimal(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,38})$/u.test(value)) return false;
  return BigInt(value) <= (1n << 128n) - 1n;
}

/** Validates the canonical protocol-v2 response envelope at an untrusted transport boundary. */
export function isRuntimeResponseEnvelope(value: unknown): value is RuntimeResponseEnvelope {
  const candidate = exactRecord(value, ["protocolVersion", "requestId", "response"]);
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(candidate.requestId) &&
    isOpenWranglerResponse(candidate.response)
  );
}

/** Validates every canonical protocol-v2 response variant and its structural payload. */
export function isOpenWranglerResponse(value: unknown): value is OpenWranglerResponse {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const definition = RESPONSE_SHAPES_BY_KIND.get(value.kind);
  if (definition === undefined) return false;
  const candidate = exactRecord(value, definition.required, definition.optional);
  if (candidate === undefined) return false;

  switch (candidate.kind) {
    case "initialized":
      return isInitializedResponse(candidate);
    case "sessionOpened":
      return isSessionOpenedResponse(candidate);
    case "page":
      return isPageResponse(candidate);
    case "summary":
      return isSummaryResponse(candidate);
    case "datasetStats":
      return isDatasetStatsResponse(candidate);
    case "columnValues":
      return isValuesResponse(candidate);
    case "stepPreview":
      return isStepPreviewResponse(candidate);
    case "stepInspection":
      return isStepInspectionResponse(candidate);
    case "planUpdated":
      return isPlanUpdatedResponse(candidate);
    case "dataExported":
      return isDataExportedResponse(candidate);
    case "sessionClosed":
      return isSessionClosedResponse(candidate);
    case "cancelled":
      return isCancelledResponse(candidate);
    case "error":
      return isErrorResponse(candidate);
    default:
      return false;
  }
}

function isInitializedResponse(candidate: UnknownRecord): boolean {
  return (
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isString(candidate.runtimeVersion) &&
    isSourceCapabilities(candidate.capabilities)
  );
}

function isSessionOpenedResponse(candidate: UnknownRecord): boolean {
  return (
    isSessionMetadata(candidate.metadata) &&
    isLiveGridPageForMetadata(candidate.page, candidate.metadata) &&
    isColumnSummaryArray(candidate.summaries, candidate.metadata.schema)
  );
}

function isPageResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isSessionMetadata(candidate.metadata) &&
    isLiveGridPageForMetadata(candidate.page, candidate.metadata)
  );
}

function isSummaryResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isColumnSummaryArray(candidate.summaries)
  );
}

function isDatasetStatsResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.viewRequestId) &&
    isDatasetStats(candidate.stats)
  );
}

function isValuesResponse(candidate: UnknownRecord): boolean {
  if (
    !isNonNegativeInteger(candidate.revision) ||
    !isNonEmptyString(candidate.viewRequestId) ||
    !isString(candidate.column) ||
    !isArrayOf(candidate.values, isValueCount) ||
    !isBoolean(candidate.hasMore)
  ) {
    return false;
  }
  if (candidate.sampleSize === undefined) return true;
  if (!isNonNegativeSafeInteger(candidate.sampleSize) || candidate.sampleSize === 0 || candidate.hasMore !== true) {
    return false;
  }
  let countedRows = 0;
  for (const valueCount of candidate.values as UnknownRecord[]) {
    countedRows += valueCount.count as number;
    if (countedRows > candidate.sampleSize) return false;
  }
  return true;
}

function isStepPreviewResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isSessionMetadata(candidate.metadata) &&
    isGridPageForRowAxis(candidate.page, candidate.metadata.schema, candidate.metadata.rowAxis) &&
    isDataDiff(candidate.diff, candidate.metadata.schema) &&
    isString(candidate.code) &&
    optional(candidate, "remainingMissingCells", isNonNegativeInteger) &&
    (candidate.remainingMissingCells === undefined ||
      (isNonNegativeInteger(candidate.remainingMissingCells) &&
        (candidate.metadata.shape.rows === null ||
          candidate.remainingMissingCells <= candidate.metadata.shape.rows))) &&
    (candidate.metadata.draftStep?.kind === "fillMissingValues") === (candidate.remainingMissingCells !== undefined) &&
    optional(candidate, "warnings", (warnings) => isArrayOf(warnings, isString))
  );
}

function isStepInspectionResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isNonEmptyString(candidate.stepId) &&
    isNonNegativeInteger(candidate.stepIndex) &&
    isColumnSchemaArray(candidate.inputSchema) &&
    isColumnSchemaArray(candidate.outputSchema) &&
    isRowAxis(candidate.inputRowAxis) &&
    isRowAxis(candidate.outputRowAxis) &&
    isGridPageForRowAxis(candidate.inputPage, candidate.inputSchema, candidate.inputRowAxis) &&
    isGridPageForRowAxis(candidate.outputPage, candidate.outputSchema, candidate.outputRowAxis) &&
    isDataDiff(candidate.diff, candidate.outputSchema) &&
    isString(candidate.code)
  );
}

function isPlanUpdatedResponse(candidate: UnknownRecord): boolean {
  return (
    isOneOf(candidate.action, ["apply", "discard", "undo"]) &&
    isNonNegativeInteger(candidate.revision) &&
    isSessionMetadata(candidate.metadata) &&
    isGridPageForRowAxis(candidate.page, candidate.metadata.schema, candidate.metadata.rowAxis) &&
    isString(candidate.code)
  );
}

function isDataExportedResponse(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.revision) &&
    isString(candidate.path) &&
    isOneOf(candidate.format, ["csv", "parquet"]) &&
    isDataShape(candidate.shape)
  );
}

function isSessionClosedResponse(candidate: UnknownRecord): boolean {
  return isString(candidate.sessionId);
}

function isCancelledResponse(candidate: UnknownRecord): boolean {
  return isString(candidate.targetRequestId) && optional(candidate, "viewRequestId", isNonEmptyString);
}

function isErrorResponse(candidate: UnknownRecord): boolean {
  return (
    isString(candidate.code) &&
    isString(candidate.message) &&
    isBoolean(candidate.recoverable) &&
    optional(candidate, "detail", isString) &&
    optional(candidate, "sessionId", isString) &&
    optional(candidate, "viewRequestId", isNonEmptyString)
  );
}

function isSessionMetadata(value: unknown): value is SessionMetadata {
  const candidate = exactRecord(
    value,
    [
      "protocolVersion",
      "sessionId",
      "revision",
      "backend",
      "mode",
      "source",
      "capabilities",
      "shape",
      "filteredShape",
      "schema",
      "filterModel",
      "steps"
    ],
    ["latestStepInputSchema", "draftStep", "draftReplacesStepId", "stats", "rDataframeFlavor", "rowAxis"]
  );
  return (
    candidate !== undefined &&
    candidate.protocolVersion === PROTOCOL_VERSION &&
    isString(candidate.sessionId) &&
    isNonNegativeInteger(candidate.revision) &&
    isOneOf(candidate.backend, DATA_BACKENDS) &&
    (candidate.backend !== "pyspark" ||
      (isRecord(candidate.source) && candidate.source.kind === "notebookVariable" && candidate.mode === "viewing")) &&
    (candidate.backend !== "r" ||
      (isRecord(candidate.source) &&
        (candidate.source.kind === "notebookVariable" ||
          candidate.source.kind === "documentVariable" ||
          candidate.source.kind === "rInteractiveVariable"))) &&
    (!isRecord(candidate.source) || candidate.source.kind !== "rInteractiveVariable" || candidate.backend === "r") &&
    (candidate.backend === "r"
      ? isOneOf(candidate.rDataframeFlavor, R_DATAFRAME_FLAVORS)
      : !Object.prototype.hasOwnProperty.call(candidate, "rDataframeFlavor")) &&
    isOneOf(candidate.mode, ["viewing", "editing"]) &&
    isSessionSource(candidate.source) &&
    isSourceCapabilities(candidate.capabilities) &&
    hasCompatibleInsertionCapabilities(candidate.source, candidate.capabilities) &&
    isSessionDataShape(candidate.shape) &&
    isSessionDataShape(candidate.filteredShape) &&
    (candidate.backend === "pyspark" || (candidate.shape.rows !== null && candidate.filteredShape.rows !== null)) &&
    isColumnSchemaArray(candidate.schema) &&
    (candidate.backend === "pandas"
      ? isRowAxis(candidate.rowAxis)
      : !Object.prototype.hasOwnProperty.call(candidate, "rowAxis")) &&
    isFilterModel(candidate.filterModel) &&
    Array.isArray(candidate.steps) &&
    candidate.steps.every(isRetainedTransformStep) &&
    (candidate.steps.length === 0 || Object.prototype.hasOwnProperty.call(candidate, "latestStepInputSchema")) &&
    optional(candidate, "latestStepInputSchema", isColumnSchemaArray) &&
    optional(candidate, "draftStep", isRetainedTransformStep) &&
    optional(candidate, "draftReplacesStepId", isString) &&
    optional(candidate, "stats", isDatasetStats)
  );
}

function isSessionSource(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "label"], ["path", "uri", "variableName", "importOptions"]);
  if (
    candidate === undefined ||
    !isOneOf(candidate.kind, [
      "file",
      "notebookVariable",
      "documentVariable",
      "rInteractiveVariable",
      "notebookOutput"
    ]) ||
    !isNonEmptyString(candidate.label) ||
    !optional(candidate, "path", isString) ||
    !optional(candidate, "uri", isString) ||
    !optional(candidate, "variableName", isString) ||
    !optional(candidate, "importOptions", isImportOptions)
  ) {
    return false;
  }
  if (candidate.kind === "documentVariable") {
    return (
      isNonEmptyString(candidate.variableName) &&
      isCanonicalSourceUri(candidate.uri) &&
      !Object.prototype.hasOwnProperty.call(candidate, "path") &&
      !Object.prototype.hasOwnProperty.call(candidate, "importOptions")
    );
  }
  if (candidate.kind === "rInteractiveVariable") {
    return (
      isNonEmptyString(candidate.variableName) &&
      !Object.prototype.hasOwnProperty.call(candidate, "path") &&
      !Object.prototype.hasOwnProperty.call(candidate, "uri") &&
      !Object.prototype.hasOwnProperty.call(candidate, "importOptions")
    );
  }
  return hasCompatibleImportOptions(candidate);
}

function isCanonicalSourceUri(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_SOURCE_URI.test(value);
}

function hasCompatibleImportOptions(source: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(source, "importOptions")) return true;
  const options = source.importOptions;
  if (!isRecord(options)) return false;
  const keys = Object.keys(options);
  if (keys.length === 0) return true;
  if (source.kind !== "file") return false;
  const extension = sourceExtension(source);
  const excelFields = new Set(["sheetName", "sheetIndex"]);
  const delimitedFields = new Set(["delimiter", "encoding", "quoteChar", "hasHeader"]);
  if (extension === "xlsx" || extension === "xls") return keys.every((key) => excelFields.has(key));
  if (extension === "csv" || extension === "tsv") return keys.every((key) => delimitedFields.has(key));
  return false;
}

function sourceExtension(source: Record<string, unknown>): string | undefined {
  const path = isNonEmptyString(source.path) ? source.path : undefined;
  const uri = path === undefined && isNonEmptyString(source.uri) ? source.uri : undefined;
  const label = path === undefined && uri === undefined && isNonEmptyString(source.label) ? source.label : undefined;
  const location = path ?? uri ?? label;
  if (location === undefined) return undefined;
  const pathname = (uri === undefined ? location : (uri.split(/[?#]/u, 1)[0] ?? "")).replaceAll("\\", "/");
  const fileName = pathname?.slice((pathname.lastIndexOf("/") ?? -1) + 1);
  const separator = fileName?.lastIndexOf(".") ?? -1;
  return separator > 0 && fileName ? fileName.slice(separator + 1).toLowerCase() : undefined;
}

function isImportOptions(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    [],
    ["delimiter", "encoding", "quoteChar", "hasHeader", "sheetName", "sheetIndex"]
  );
  if (candidate === undefined) return false;
  const hasSheetName = Object.prototype.hasOwnProperty.call(candidate, "sheetName");
  const hasSheetIndex = Object.prototype.hasOwnProperty.call(candidate, "sheetIndex");
  const hasExcelSelector = hasSheetName || hasSheetIndex;
  const hasDelimitedOption = ["delimiter", "encoding", "quoteChar", "hasHeader"].some((key) =>
    Object.prototype.hasOwnProperty.call(candidate, key)
  );
  return (
    optional(candidate, "delimiter", isSingleCharacter) &&
    optional(candidate, "encoding", isNonEmptyTrimmedString) &&
    optional(candidate, "quoteChar", isSingleCharacter) &&
    optional(candidate, "hasHeader", isBoolean) &&
    optional(candidate, "sheetName", isNonEmptyTrimmedString) &&
    optional(candidate, "sheetIndex", isNonNegativeSafeInteger) &&
    !(hasSheetName && hasSheetIndex) &&
    !(hasExcelSelector && hasDelimitedOption)
  );
}

function isSourceCapabilities(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["editable", "lazy", "cancel", "exportCsv", "exportParquet", "notebookInsert"],
    ["documentInsert", "filter", "sort", "profile", "columnValues", "supportedOperations"]
  );
  return (
    candidate !== undefined &&
    isBoolean(candidate.editable) &&
    isBoolean(candidate.lazy) &&
    isBoolean(candidate.cancel) &&
    isBoolean(candidate.exportCsv) &&
    isBoolean(candidate.exportParquet) &&
    isBoolean(candidate.notebookInsert) &&
    optional(candidate, "documentInsert", isBoolean) &&
    optional(candidate, "filter", isBoolean) &&
    optional(candidate, "sort", isBoolean) &&
    optional(candidate, "profile", isBoolean) &&
    optional(candidate, "columnValues", isBoolean) &&
    optional(candidate, "supportedOperations", isUniqueOperationKindArray)
  );
}

function hasCompatibleInsertionCapabilities(source: unknown, capabilities: unknown): boolean {
  if (!isRecord(source) || !isRecord(capabilities)) return false;
  return (
    (capabilities.notebookInsert !== true || source.kind === "notebookVariable") &&
    (capabilities.documentInsert !== true || source.kind === "documentVariable")
  );
}

function isUniqueOperationKindArray(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (!value.every((kind) => isString(kind) && OPERATION_DEFINITIONS.has(kind))) return false;
  return new Set(value).size === value.length;
}

function isDataShape(value: unknown): boolean {
  const candidate = exactRecord(value, ["rows", "columns"]);
  return candidate !== undefined && isNonNegativeInteger(candidate.rows) && isNonNegativeInteger(candidate.columns);
}

function isSessionDataShape(value: unknown): value is SessionDataShape {
  const candidate = exactRecord(value, ["rows", "columns"]);
  return (
    candidate !== undefined &&
    (candidate.rows === null || isNonNegativeInteger(candidate.rows)) &&
    isNonNegativeInteger(candidate.columns)
  );
}

function isColumnSchema(value: unknown): boolean {
  const candidate = exactRecord(value, ["id", "name", "position", "rawType", "type", "nullable"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.id) &&
    isString(candidate.name) &&
    isNonNegativeInteger(candidate.position) &&
    isString(candidate.rawType) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    isBoolean(candidate.nullable)
  );
}

export function isColumnSchemaArray(value: unknown): value is ColumnSchema[] {
  if (!Array.isArray(value)) return false;
  const identities = new Set<string>();
  return value.every((column, position) => {
    if (!isColumnSchema(column)) return false;
    const candidate = column as { id: string; position: number };
    if (candidate.position !== position || identities.has(candidate.id)) return false;
    identities.add(candidate.id);
    return true;
  });
}

function isColumnReference(value: unknown): value is ColumnReference {
  const candidate = exactRecord(value, ["id", "name"]);
  return candidate !== undefined && isNonEmptyString(candidate.id) && isString(candidate.name);
}

function isUniqueColumnReferenceArray(value: unknown, allowEmpty: boolean): value is ColumnReference[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every(isColumnReference)) return false;
  return new Set(value.map((reference) => reference.id)).size === value.length;
}

export function isFilterModel(value: unknown): value is FilterModel {
  const candidate = exactRecord(value, ["filters", "sort"], ["logic"]);
  return (
    candidate !== undefined &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    isArrayOf(candidate.filters, isColumnFilter) &&
    isUniqueViewSortRuleArray(candidate.sort)
  );
}

function isColumnFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["column", "type", "predicates"], ["logic", "valueFilter"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    optional(candidate, "valueFilter", isValueFilter) &&
    isArrayOf(candidate.predicates, isPredicateFilter)
  );
}

function isValueFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "selectedValues", "includeNulls", "includeNaN"], ["search"]);
  return (
    candidate !== undefined &&
    candidate.kind === "values" &&
    isArrayOf(candidate.selectedValues, isBoundedViewValue) &&
    isBoolean(candidate.includeNulls) &&
    isBoolean(candidate.includeNaN) &&
    optional(candidate, "search", isString)
  );
}

function isPredicateFilter(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "operator"], ["value", "secondValue"]);
  if (
    candidate === undefined ||
    candidate.kind !== "predicate" ||
    !isEnumMember(candidate.operator, PREDICATE_OPERATORS)
  ) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(candidate, "value") && !isBoundedViewValue(candidate.value)) return false;
  if (Object.prototype.hasOwnProperty.call(candidate, "secondValue") && !isBoundedViewValue(candidate.secondValue))
    return false;
  const nullary = new Set(["isNull", "isNotNull", "isNaN", "isNotNaN"]);
  if (!nullary.has(candidate.operator) && !Object.prototype.hasOwnProperty.call(candidate, "value")) return false;
  return candidate.operator !== "between" || Object.prototype.hasOwnProperty.call(candidate, "secondValue");
}

function isSortRule(value: unknown): value is FilterModel["sort"][number] {
  const candidate = exactRecord(value, ["column", "direction", "nulls"]);
  return (
    candidate !== undefined &&
    isNonEmptyString(candidate.column) &&
    isOneOf(candidate.direction, ["asc", "desc"]) &&
    isOneOf(candidate.nulls, ["first", "last"])
  );
}

function isUniqueViewSortRuleArray(value: unknown): value is FilterModel["sort"] {
  if (!Array.isArray(value) || !value.every(isSortRule)) return false;
  return new Set(value.map((rule) => rule.column)).size === value.length;
}

function isTransformSortRule(value: unknown): value is TransformSortRule {
  const candidate = exactRecord(value, ["column", "direction", "nulls"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isOneOf(candidate.direction, ["asc", "desc"]) &&
    isOneOf(candidate.nulls, ["first", "last"])
  );
}

function isTransformColumnFilter(value: unknown): value is TransformColumnFilter {
  const candidate = exactRecord(value, ["column", "type", "predicates"], ["logic", "valueFilter"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    optional(candidate, "valueFilter", isValueFilter) &&
    isArrayOf(candidate.predicates, isPredicateFilter)
  );
}

function hasUniqueReferencedColumnIds(values: readonly { column: ColumnReference }[]): boolean {
  return new Set(values.map((value) => value.column.id)).size === values.length;
}

function isUniqueTransformSortRuleArray(value: unknown, allowEmpty: boolean): value is TransformSortRule[] {
  return (
    Array.isArray(value) &&
    (allowEmpty || value.length > 0) &&
    value.every(isTransformSortRule) &&
    hasUniqueReferencedColumnIds(value)
  );
}

function isUniqueTransformColumnFilterArray(value: unknown): value is TransformColumnFilter[] {
  return Array.isArray(value) && value.every(isTransformColumnFilter) && hasUniqueReferencedColumnIds(value);
}

function isTransformFilterModel(value: unknown): boolean {
  const candidate = exactRecord(value, ["filters", "sort"], ["logic"]);
  return (
    candidate !== undefined &&
    optional(candidate, "logic", (logic) => isOneOf(logic, ["and", "or"])) &&
    isUniqueTransformColumnFilterArray(candidate.filters) &&
    isUniqueTransformSortRuleArray(candidate.sort, true)
  );
}

const FILL_INTEGER_TEXT = /^-?(?:0|[1-9][0-9]*)$/u;
const FILL_NUMBER_TEXT = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u;
const FILL_DATE_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const FILL_DATETIME_TEXT =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,6})?)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?$/u;
const MAX_FILL_INTEGER = 10n ** 38n - 1n;
const MAX_FILL_FALLBACK_COLUMNS = 64;
const MAX_FILL_DIRECTIONAL_GAP = 1_000_000;

function isFillMissingReplacement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === "median" || value.kind === "mean" || value.kind === "mostFrequent") {
    return exactRecord(value, ["kind"]) !== undefined;
  }
  if (value.kind === "fallbackColumns") {
    const decoded = exactRecord(value, ["kind", "columns"]);
    return (
      decoded !== undefined &&
      Array.isArray(decoded.columns) &&
      decoded.columns.length <= MAX_FILL_FALLBACK_COLUMNS &&
      isUniqueColumnReferenceArray(decoded.columns, false)
    );
  }
  if (value.kind === "directional") {
    const decoded = exactRecord(value, ["kind", "direction", "orderBy"], ["maxGap"]);
    return (
      decoded !== undefined &&
      isOneOf(decoded.direction, ["forward", "backward"]) &&
      isUniqueTransformSortRuleArray(decoded.orderBy, false) &&
      optional(decoded, "maxGap", (maxGap) => isPositiveInteger(maxGap) && maxGap <= MAX_FILL_DIRECTIONAL_GAP)
    );
  }
  if (value.kind === "groupedStatistic") {
    const decoded = exactRecord(value, ["kind", "statistic", "keys"]);
    return (
      decoded !== undefined &&
      isOneOf(decoded.statistic, ["median", "mean", "mostFrequent"]) &&
      isUniqueColumnReferenceArray(decoded.keys, false)
    );
  }
  if (value.kind === "linearInterpolation") {
    const decoded = exactRecord(value, ["kind", "coordinate"], ["maxGap"]);
    return (
      decoded !== undefined &&
      isColumnReference(decoded.coordinate) &&
      optional(decoded, "maxGap", (maxGap) => isPositiveInteger(maxGap) && maxGap <= MAX_FILL_DIRECTIONAL_GAP)
    );
  }
  const decoded = exactRecord(value, ["kind", "value"]);
  if (decoded === undefined) return false;
  switch (decoded.kind) {
    case "string":
      return isString(decoded.value) && hasAtMostViewValueTextCodePoints(decoded.value);
    case "boolean":
      return isBoolean(decoded.value);
    case "integer": {
      if (!isString(decoded.value) || decoded.value.length > 40 || !FILL_INTEGER_TEXT.test(decoded.value)) return false;
      try {
        const parsed = BigInt(decoded.value);
        return parsed >= -MAX_FILL_INTEGER && parsed <= MAX_FILL_INTEGER;
      } catch {
        return false;
      }
    }
    case "float":
      return (
        isString(decoded.value) &&
        decoded.value.length <= 64 &&
        FILL_NUMBER_TEXT.test(decoded.value) &&
        Number.isFinite(Number(decoded.value))
      );
    case "decimal":
      return isPortableFillDecimal(decoded.value);
    case "date":
      return isString(decoded.value) && FILL_DATE_TEXT.test(decoded.value) && isValidFillDate(decoded.value);
    case "datetime":
      return (
        isString(decoded.value) &&
        decoded.value.length <= 64 &&
        FILL_DATETIME_TEXT.test(decoded.value) &&
        isValidFillDatetime(decoded.value)
      );
    default:
      return false;
  }
}

function isPortableFillDecimal(value: unknown): boolean {
  if (!isString(value) || value.length > 128 || !FILL_NUMBER_TEXT.test(value)) return false;
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const [coefficient, exponentText] = unsigned.toLowerCase().split("e");
  const [whole, fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/u, "");
  if (digits.length === 0) return true;
  if (digits.length > 38) return false;
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent)) return false;
  const adjusted =
    whole.replace(/^0+/u, "").length > 0
      ? whole.replace(/^0+/u, "").length - 1 + exponent
      : -fraction.search(/[1-9]/u) - 1 + exponent;
  return adjusted >= -38 && adjusted <= 37;
}

function isValidFillDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function isValidFillDatetime(value: string): boolean {
  if (!isValidFillDate(value.slice(0, 10))) return false;
  const time = value.slice(11);
  const match = time.match(
    /^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,6})?)?(?:Z|([+-])([0-9]{2}):?([0-9]{2}))?$/u
  );
  if (!match) return false;
  const [, hours, minutes, seconds = "0", , offsetHours = "0", offsetMinutes = "0"] = match;
  return (
    Number(hours) <= 23 &&
    Number(minutes) <= 59 &&
    Number(seconds) <= 59 &&
    Number(offsetHours) <= 23 &&
    Number(offsetMinutes) <= 59
  );
}

export function isTransformStep(value: unknown): value is TransformStep {
  const candidate = exactRecord(value, ["id", "kind", "params"]);
  if (candidate === undefined || !isNonEmptyString(candidate.id) || !isString(candidate.kind)) return false;
  const definition = OPERATION_DEFINITIONS.get(candidate.kind);
  if (definition === undefined) return false;
  const params = exactRecord(candidate.params, definition.required, definition.optional);
  if (params === undefined) return false;

  switch (candidate.kind) {
    case "sortRows":
      return isUniqueTransformSortRuleArray(params.rules, false);
    case "filterRows":
      return isTransformFilterModel(params.filterModel);
    case "dropMissingRows": {
      return (
        optional(params, "columns", (columns) => isUniqueColumnReferenceArray(columns, true)) &&
        optional(params, "how", (how) => isOneOf(how, ["any", "all"]))
      );
    }
    case "fillMissingValues": {
      if (!isColumnReference(params.column) || !isFillMissingReplacement(params.replacement)) {
        return false;
      }
      const targetColumnId = params.column.id;
      if (!isRecord(params.replacement)) return true;
      if (
        params.replacement.kind === "fallbackColumns" &&
        Array.isArray(params.replacement.columns) &&
        params.replacement.columns.some((reference) => isRecord(reference) && reference.id === targetColumnId)
      ) {
        return false;
      }
      if (
        params.replacement.kind === "groupedStatistic" &&
        Array.isArray(params.replacement.keys) &&
        params.replacement.keys.some((reference) => isRecord(reference) && reference.id === targetColumnId)
      ) {
        return false;
      }
      if (
        params.replacement.kind === "linearInterpolation" &&
        isRecord(params.replacement.coordinate) &&
        params.replacement.coordinate.id === targetColumnId
      ) {
        return false;
      }
      return !(
        params.replacement.kind === "directional" &&
        Array.isArray(params.replacement.orderBy) &&
        params.replacement.orderBy.some(
          (rule) => isRecord(rule) && isRecord(rule.column) && rule.column.id === targetColumnId
        )
      );
    }
    case "dropDuplicates": {
      return (
        optional(params, "columns", (columns) => isUniqueColumnReferenceArray(columns, false)) &&
        optional(params, "keep", (keep) => isOneOf(keep, ["first", "last", "none"]))
      );
    }
    case "selectColumns":
    case "dropColumns":
      return isUniqueColumnReferenceArray(params.columns, false);
    case "renameColumn":
    case "cloneColumn":
      return isColumnReference(params.column) && isNonEmptyString(params.newName);
    case "castColumn":
      return isColumnReference(params.column) && isEnumMember(params.dtype, CAST_DTYPES);
    case "formula": {
      if (
        !isColumnReference(params.leftColumn) ||
        !isEnumMember(params.operator, FORMULA_OPERATORS) ||
        !isNonEmptyString(params.newColumn)
      ) {
        return false;
      }
      const hasColumn = Object.prototype.hasOwnProperty.call(params, "rightColumn");
      const hasValue = Object.prototype.hasOwnProperty.call(params, "value");
      return (
        hasColumn !== hasValue &&
        (!hasColumn || isColumnReference(params.rightColumn)) &&
        (!hasValue || isFiniteNumber(params.value))
      );
    }
    case "textLength":
      return isColumnReference(params.column) && isNonEmptyString(params.newColumn);
    case "oneHotEncode": {
      return (
        isUniqueColumnReferenceArray(params.columns, false) &&
        optional(params, "prefixSeparator", isString) &&
        optional(params, "dropOriginal", isBoolean)
      );
    }
    case "multiLabelBinarize": {
      return (
        isColumnReference(params.column) &&
        isNonEmptyString(params.delimiter) &&
        optional(params, "prefix", isString) &&
        optional(params, "dropOriginal", isBoolean)
      );
    }
    case "findReplace": {
      return (
        isColumnReference(params.column) &&
        isString(params.find) &&
        isString(params.replacement) &&
        optional(params, "regex", isBoolean) &&
        optional(params, "newColumn", isNonEmptyString)
      );
    }
    case "stripText": {
      return (
        isColumnReference(params.column) &&
        optional(params, "characters", (characters) => characters === null || isNonEmptyString(characters)) &&
        optional(params, "newColumn", isNonEmptyString)
      );
    }
    case "splitText": {
      return (
        isColumnReference(params.column) &&
        isNonEmptyString(params.delimiter) &&
        isNonNegativeInteger(params.index) &&
        isNonEmptyString(params.newColumn)
      );
    }
    case "splitTextColumns": {
      return (
        isColumnReference(params.column) &&
        isNonEmptyString(params.delimiter) &&
        isUniqueNonEmptyStringArray(params.newColumns) &&
        params.newColumns.length >= 2 &&
        params.newColumns.length <= 64
      );
    }
    case "extractRegexGroup": {
      if (
        !isColumnReference(params.column) ||
        !isNonEmptyString(params.pattern) ||
        !isInteger(params.group) ||
        !isNonEmptyString(params.newColumn)
      ) {
        return false;
      }
      try {
        portableRegexContract(params.pattern, params.group);
        validatePortableRegexOutputName(params.newColumn);
        return true;
      } catch {
        return false;
      }
    }
    case "capitalizeText":
    case "lowerText":
    case "upperText":
    case "minMaxScale":
    case "floorNumber":
    case "ceilNumber": {
      return isColumnReference(params.column) && optional(params, "newColumn", isNonEmptyString);
    }
    case "roundNumber": {
      return (
        isColumnReference(params.column) &&
        optional(params, "decimals", isInteger) &&
        optional(params, "newColumn", isNonEmptyString)
      );
    }
    case "formatDatetime": {
      return (
        isColumnReference(params.column) &&
        isNonEmptyString(params.format) &&
        optional(params, "newColumn", isNonEmptyString)
      );
    }
    case "pivotLonger": {
      if (
        !isUniqueColumnReferenceArray(params.columns, false) ||
        params.columns.length < MIN_PIVOT_LONGER_COLUMNS ||
        params.columns.length > MAX_PIVOT_LONGER_COLUMNS ||
        !isNonEmptyString(params.labelColumn) ||
        !isNonEmptyString(params.valueColumn) ||
        portablePivotLongerNameKey(params.labelColumn) === portablePivotLongerNameKey(params.valueColumn)
      ) {
        return false;
      }
      try {
        validatePivotLongerOutputName(params.labelColumn, "Pivot longer label output name");
        validatePivotLongerOutputName(params.valueColumn, "Pivot longer value output name");
        return true;
      } catch {
        return false;
      }
    }
    case "pivotWider": {
      if (
        !isColumnReference(params.namesFrom) ||
        !isColumnReference(params.valuesFrom) ||
        params.namesFrom.id === params.valuesFrom.id ||
        !Array.isArray(params.outputs) ||
        params.outputs.length < MIN_PIVOT_WIDER_OUTPUTS ||
        params.outputs.length > MAX_PIVOT_WIDER_OUTPUTS
      ) {
        return false;
      }
      const keyValues: string[] = [];
      const outputKeys: string[] = [];
      try {
        for (const [index, output] of params.outputs.entries()) {
          const item = exactRecord(output, ["key", "name"]);
          if (item === undefined || !isTypedSelectionToken(item.key) || !isNonEmptyString(item.name)) return false;
          keyValues.push(pivotWiderKeyValue(item.key as TypedSelectionToken));
          validatePivotWiderOutputName(item.name, `Pivot wider output ${index + 1} name`);
          outputKeys.push(portablePivotWiderNameKey(item.name));
        }
      } catch {
        return false;
      }
      return new Set(keyValues).size === keyValues.length && new Set(outputKeys).size === outputKeys.length;
    }
    case "groupBy": {
      if (!isUniqueColumnReferenceArray(params.keys, false) || !Array.isArray(params.aggregations)) {
        return false;
      }
      const keyNames = new Set(params.keys.map((reference) => reference.name));
      const aliases: string[] = [];
      for (const aggregation of params.aggregations) {
        if (!isAggregation(aggregation)) return false;
        aliases.push(aggregation.alias);
      }
      if (aliases.length === 0) return false;
      return new Set(aliases).size === aliases.length && aliases.every((alias) => !keyNames.has(alias));
    }
    case "byExample":
      return isByExampleParams(params);
    case "customCode":
      return (
        isNonEmptyTrimmedString(params.code) && hasAtMostStrictUtf8Bytes(params.code, MAX_PYTHON_CUSTOM_CODE_UTF8_BYTES)
      );
    default:
      return false;
  }
}

export function hasAtMostStrictUtf8Bytes(value: string, maximumBytes: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const trailing = value.charCodeAt(index + 1);
      if (trailing < 0xdc00 || trailing > 0xdfff) return false;
      bytes += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    } else if (codeUnit <= 0x7f) {
      bytes += 1;
    } else if (codeUnit <= 0x7ff) {
      bytes += 2;
    } else {
      bytes += 3;
    }
    if (bytes > maximumBytes) return false;
  }
  return true;
}

/**
 * Runtime metadata and persisted cleaning state must retain the exact program
 * selected for a by-example step. New preview requests may omit it so the
 * runtime can synthesize a candidate, but replay must never synthesize again.
 */
export function isRetainedTransformStep(value: unknown): value is TransformStep {
  return isTransformStep(value) && (value.kind !== "byExample" || value.params.program !== undefined);
}

function isAggregation(value: unknown): value is { column: ColumnReference; operation: string; alias: string } {
  const candidate = exactRecord(value, ["column", "operation", "alias"]);
  return (
    candidate !== undefined &&
    isColumnReference(candidate.column) &&
    isEnumMember(candidate.operation, AGGREGATIONS) &&
    isNonEmptyString(candidate.alias)
  );
}

function isByExampleParams(candidate: UnknownRecord): boolean {
  const sourceColumns = candidate.sourceColumns;
  const examples = candidate.examples;
  const hasProgram = Object.prototype.hasOwnProperty.call(candidate, "program");
  const hasWarnings = Object.prototype.hasOwnProperty.call(candidate, "warnings");
  if (
    !Array.isArray(sourceColumns) ||
    sourceColumns.length === 0 ||
    sourceColumns.length > MAX_BY_EXAMPLE_SOURCE_COLUMNS ||
    !isNonEmptyString(candidate.newColumn) ||
    !Array.isArray(examples) ||
    examples.length < 2 ||
    examples.length > MAX_BY_EXAMPLE_EXAMPLES ||
    (hasWarnings && (!Array.isArray(candidate.warnings) || candidate.warnings.length > MAX_BY_EXAMPLE_WARNINGS)) ||
    (hasProgram && !hasBoundedByExampleProgramShape(candidate.program))
  ) {
    return false;
  }
  if (!isUniqueColumnReferenceArray(sourceColumns, false)) return false;
  const budget: ByExampleValidationBudget = {
    remainingNodes: MAX_BY_EXAMPLE_PROGRAM_NODES,
    remainingTextBytes: MAX_BY_EXAMPLE_TEXT_UTF8_BYTES
  };
  if (
    !sourceColumns.every(
      (reference) => consumeByExampleString(reference.id, budget) && consumeByExampleString(reference.name, budget)
    ) ||
    !consumeByExampleString(candidate.newColumn, budget) ||
    !examples.every((example) => isByExampleItem(example, sourceColumns, budget))
  ) {
    return false;
  }
  const sourceById = new Map(sourceColumns.map((reference) => [reference.id, reference.name]));
  return (
    optional(candidate, "program", (program) => isByExampleProgram(program, 0, sourceById, budget)) &&
    optional(
      candidate,
      "warnings",
      (warnings) =>
        Array.isArray(warnings) &&
        warnings.length <= MAX_BY_EXAMPLE_WARNINGS &&
        warnings.every((warning) => isString(warning) && consumeByExampleString(warning, budget))
    ) &&
    optional(candidate, "candidateCount", isPositiveByExampleSafeInteger)
  );
}

interface ByExampleValidationBudget {
  remainingNodes: number;
  remainingTextBytes: number;
}

function hasBoundedByExampleProgramShape(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const visited = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) return false;
    nodes += 1;
    if (
      nodes > MAX_BY_EXAMPLE_PROGRAM_NODES ||
      current.depth > MAX_BY_EXAMPLE_PROGRAM_DEPTH ||
      !isRecord(current.value) ||
      typeof current.value.kind !== "string" ||
      visited.has(current.value)
    ) {
      return false;
    }
    visited.add(current.value);
    const nested = (child: unknown) => pending.push({ value: child, depth: current.depth + 1 });
    switch (current.value.kind) {
      case "column":
      case "literal":
        break;
      case "slice":
      case "split":
      case "regexExtract":
      case "regexReplace":
      case "case":
      case "datetimeFormat":
        nested(current.value.input);
        break;
      case "concat": {
        const parts = current.value.parts;
        if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_BY_EXAMPLE_CONCAT_PARTS) {
          return false;
        }
        for (const part of parts) nested(part);
        break;
      }
      case "arithmetic":
        nested(current.value.left);
        nested(current.value.right);
        break;
      default:
        return false;
    }
  }
  return true;
}

function isByExampleItem(
  value: unknown,
  sourceColumns: readonly ColumnReference[],
  budget: ByExampleValidationBudget
): boolean {
  const candidate = exactRecord(value, ["inputs", "output"]);
  return (
    candidate !== undefined &&
    Array.isArray(candidate.inputs) &&
    candidate.inputs.length === sourceColumns.length &&
    candidate.inputs.every((input) => isBoundedByExampleScalar(input, budget)) &&
    isBoundedByExampleScalar(candidate.output, budget)
  );
}

function isByExampleProgram(
  value: unknown,
  depth: number,
  sourceById: ReadonlyMap<string, string>,
  budget: ByExampleValidationBudget
): boolean {
  budget.remainingNodes -= 1;
  if (
    budget.remainingNodes < 0 ||
    depth > MAX_BY_EXAMPLE_PROGRAM_DEPTH ||
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !consumeByExampleString(value.kind, budget)
  ) {
    return false;
  }
  const nested = (candidate: unknown) => isByExampleProgram(candidate, depth + 1, sourceById, budget);
  switch (value.kind) {
    case "column": {
      const candidate = exactRecord(value, ["kind", "column"]);
      return (
        candidate !== undefined &&
        isColumnReference(candidate.column) &&
        consumeByExampleString(candidate.column.id, budget) &&
        consumeByExampleString(candidate.column.name, budget) &&
        sourceById.get(candidate.column.id) === candidate.column.name
      );
    }
    case "literal": {
      const candidate = exactRecord(value, ["kind", "value"]);
      return candidate !== undefined && isBoundedByExampleScalar(candidate.value, budget);
    }
    case "slice": {
      const candidate = exactRecord(value, ["kind", "input", "start"], ["stop"]);
      return (
        candidate !== undefined &&
        isNonNegativeByExampleSafeInteger(candidate.start) &&
        optional(
          candidate,
          "stop",
          (stop) => stop === null || (isNonNegativeByExampleSafeInteger(stop) && stop >= (candidate.start as number))
        ) &&
        nested(candidate.input)
      );
    }
    case "split": {
      const candidate = exactRecord(value, ["kind", "input", "delimiter", "index"]);
      return (
        candidate !== undefined &&
        isString(candidate.delimiter) &&
        consumeByExampleString(candidate.delimiter, budget) &&
        isNonNegativeByExampleSafeInteger(candidate.index) &&
        nested(candidate.input)
      );
    }
    case "concat": {
      const candidate = exactRecord(value, ["kind", "parts"]);
      return (
        candidate !== undefined &&
        Array.isArray(candidate.parts) &&
        candidate.parts.length > 0 &&
        candidate.parts.length <= MAX_BY_EXAMPLE_CONCAT_PARTS &&
        candidate.parts.every(nested)
      );
    }
    case "regexExtract": {
      const candidate = exactRecord(value, ["kind", "input", "pattern", "group"]);
      return (
        candidate !== undefined &&
        isString(candidate.pattern) &&
        consumeByExampleString(candidate.pattern, budget) &&
        isByExampleSafeInteger(candidate.group) &&
        nested(candidate.input)
      );
    }
    case "regexReplace": {
      const candidate = exactRecord(value, ["kind", "input", "pattern", "replacement"]);
      return (
        candidate !== undefined &&
        isString(candidate.pattern) &&
        consumeByExampleString(candidate.pattern, budget) &&
        isString(candidate.replacement) &&
        consumeByExampleString(candidate.replacement, budget) &&
        nested(candidate.input)
      );
    }
    case "case": {
      const candidate = exactRecord(value, ["kind", "style", "input"]);
      return (
        candidate !== undefined &&
        isString(candidate.style) &&
        isOneOf(candidate.style, ["lower", "upper", "capitalize"]) &&
        consumeByExampleString(candidate.style, budget) &&
        nested(candidate.input)
      );
    }
    case "datetimeFormat": {
      const candidate = exactRecord(value, ["kind", "input", "inputFormat", "outputFormat"]);
      return (
        candidate !== undefined &&
        isString(candidate.inputFormat) &&
        consumeByExampleString(candidate.inputFormat, budget) &&
        isString(candidate.outputFormat) &&
        consumeByExampleString(candidate.outputFormat, budget) &&
        nested(candidate.input)
      );
    }
    case "arithmetic": {
      const candidate = exactRecord(value, ["kind", "left", "operator", "right"]);
      return (
        candidate !== undefined &&
        isString(candidate.operator) &&
        isOneOf(candidate.operator, ["add", "subtract", "multiply", "divide"]) &&
        consumeByExampleString(candidate.operator, budget) &&
        nested(candidate.left) &&
        nested(candidate.right)
      );
    }
    default:
      return false;
  }
}

function isGridPage(value: unknown, schema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, ["offset", "limit", "totalRows", "columnIds", "rows"]);
  if (candidate === undefined) return false;
  const columnIds = candidate.columnIds;
  const rows = candidate.rows;
  if (
    !isNonNegativeInteger(candidate.offset) ||
    !isPositiveInteger(candidate.limit) ||
    !isNonNegativeInteger(candidate.totalRows) ||
    !isUniqueNonEmptyStringArray(columnIds) ||
    !Array.isArray(rows) ||
    rows.length > candidate.limit
  ) {
    return false;
  }
  if (schema !== undefined && !isOrderedSchemaProjection(columnIds, schema)) return false;
  return (
    candidate.offset + rows.length <= candidate.totalRows &&
    rows.every(
      (row, position) => isDataRow(row, columnIds.length) && row.rowNumber === Number(candidate.offset) + position
    )
  );
}

function isUnknownTotalGridPage(value: unknown, schema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, ["offset", "limit", "totalRows", "hasMore", "columnIds", "rows"]);
  if (candidate === undefined) return false;
  const columnIds = candidate.columnIds;
  const rows = candidate.rows;
  if (
    !isNonNegativeInteger(candidate.offset) ||
    !isPositiveInteger(candidate.limit) ||
    candidate.totalRows !== null ||
    candidate.hasMore !== true ||
    !isUniqueNonEmptyStringArray(columnIds) ||
    !Array.isArray(rows) ||
    rows.length !== candidate.limit
  ) {
    return false;
  }
  if (schema !== undefined && !isOrderedSchemaProjection(columnIds, schema)) return false;
  return rows.every(
    (row, position) => isDataRow(row, columnIds.length) && row.rowNumber === Number(candidate.offset) + position
  );
}

function isLiveGridPageForMetadata(value: unknown, metadata: SessionMetadata): value is LiveGridPage {
  if (isGridPageForRowAxis(value, metadata.schema, metadata.rowAxis)) {
    return metadata.filteredShape.rows === (value as { totalRows: number }).totalRows;
  }
  return (
    metadata.backend === "pyspark" &&
    metadata.filteredShape.rows === null &&
    isUnknownTotalGridPage(value, metadata.schema)
  );
}

function isGridPageForRowAxis(
  value: unknown,
  schema: readonly ColumnSchema[],
  rowAxis: RowAxis | undefined
): value is GridPage {
  if (!isGridPage(value, schema)) return false;
  if (rowAxis === undefined) return true;
  const rows = (value as { rows: Array<{ rowLabel?: string }> }).rows;
  return rowAxis.kind === "positional"
    ? rows.every((row) => row.rowLabel === undefined)
    : rows.every((row) => row.rowLabel !== undefined);
}

function isRowAxis(value: unknown): value is RowAxis {
  const candidate = exactRecord(value, ["kind", "levelNames"]);
  if (
    candidate === undefined ||
    !isOneOf(candidate.kind, ["positional", "index", "multiIndex"]) ||
    !Array.isArray(candidate.levelNames) ||
    candidate.levelNames.length > 64 ||
    !candidate.levelNames.every(
      (name) => name === null || (isString(name) && hasAtMostCodePoints(name, MAX_ROW_LABEL_CODE_POINTS))
    )
  ) {
    return false;
  }
  if (candidate.kind === "positional") return candidate.levelNames.length === 0;
  if (candidate.kind === "index") return candidate.levelNames.length === 1;
  return candidate.levelNames.length >= 2;
}

function isDataRow(value: unknown, expectedWidth?: number): boolean {
  const candidate = exactRecord(value, ["id", "rowNumber", "values"], ["rowLabel"]);
  if (candidate === undefined) return false;
  const values = candidate.values;
  if (!Array.isArray(values) || !values.every(isCellValue)) return false;
  return (
    isString(candidate.id) &&
    isNonNegativeInteger(candidate.rowNumber) &&
    optional(
      candidate,
      "rowLabel",
      (rowLabel) => isString(rowLabel) && hasAtMostCodePoints(rowLabel, MAX_ROW_LABEL_CODE_POINTS)
    ) &&
    (expectedWidth === undefined || values.length === expectedWidth)
  );
}

function isOrderedSchemaProjection(columnIds: readonly string[], schema: readonly ColumnSchema[]): boolean {
  if (columnIds.length === 0) return true;
  const firstIndex = schema.findIndex((column) => column.id === columnIds[0]);
  return (
    firstIndex >= 0 &&
    firstIndex + columnIds.length <= schema.length &&
    columnIds.every((columnId, index) => schema[firstIndex + index]?.id === columnId)
  );
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) return false;
  return new Set(value).size === value.length;
}

function isCellValue(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "display", "isNull", "isNaN"], ["raw", "sign"]);
  return (
    candidate !== undefined &&
    isEnumMember(candidate.kind, CELL_KINDS) &&
    isString(candidate.display) &&
    isBoolean(candidate.isNull) &&
    isBoolean(candidate.isNaN) &&
    optional(candidate, "sign", (sign) => sign === -1 || sign === 1)
  );
}

function isColumnSummary(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["columnId", "column", "type", "rawType", "totalCount", "nullCount", "nanCount", "topValues"],
    ["distinctCount", "numeric", "text", "visualization"]
  );
  if (!(
    candidate !== undefined &&
    isNonEmptyString(candidate.columnId) &&
    isString(candidate.column) &&
    isEnumMember(candidate.type, COLUMN_TYPES) &&
    isString(candidate.rawType) &&
    isNonNegativeInteger(candidate.totalCount) &&
    isNonNegativeInteger(candidate.nullCount) &&
    isNonNegativeInteger(candidate.nanCount) &&
    optional(candidate, "distinctCount", isNonNegativeInteger) &&
    optional(candidate, "numeric", (numeric) =>
      isNumericSummary(
        numeric,
        candidate.type,
        (candidate.totalCount as number) - (candidate.nullCount as number) - (candidate.nanCount as number)
      )
    ) &&
    optional(candidate, "visualization", isColumnVisualization) &&
    isArrayOf(candidate.topValues, isValueCount)
  )) {
    return false;
  }
  if ((candidate.nullCount as number) + (candidate.nanCount as number) > (candidate.totalCount as number)) {
    return false;
  }
  const hasNumeric = Object.prototype.hasOwnProperty.call(candidate, "numeric");
  const requiresNumeric = candidate.type === "integer" || candidate.type === "float" || candidate.type === "decimal";
  if ((requiresNumeric && !hasNumeric) || (hasNumeric && !requiresNumeric && candidate.type !== "duration")) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(candidate, "text")) {
    return true;
  }
  return (
    candidate.type === "string" &&
    isTextSummary(candidate.text, candidate.totalCount - candidate.nullCount - candidate.nanCount)
  );
}

function isColumnSummaryArray(value: unknown, schema?: readonly ColumnSchema[]): value is ColumnSummary[] {
  if (!Array.isArray(value) || !value.every(isColumnSummary)) return false;
  const summaries = value as ColumnSummary[];
  const columnIds = summaries.map((summary) => summary.columnId);
  if (new Set(columnIds).size !== columnIds.length) return false;
  if (!schema) return true;
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  return summaries.every((summary) => {
    const column = schemaById.get(summary.columnId);
    return (
      column !== undefined &&
      column.name === summary.column &&
      column.type === summary.type &&
      column.rawType === summary.rawType
    );
  });
}

function isNumericSummary(value: unknown, columnType: unknown, valueCount: number): boolean {
  const candidate = exactRecord(
    value,
    [],
    ["min", "max", "mean", "median", "std", "sum", "exactMin", "exactMax", "exactSum"]
  );
  if (
    candidate === undefined ||
    !Number.isInteger(valueCount) ||
    valueCount < 0 ||
    !optional(candidate, "min", isFiniteNumber) ||
    !optional(candidate, "max", isFiniteNumber) ||
    !optional(candidate, "mean", isFiniteNumber) ||
    !optional(candidate, "median", isFiniteNumber) ||
    !optional(candidate, "std", isFiniteNumber) ||
    !optional(candidate, "sum", isFiniteNumber)
  ) {
    return false;
  }

  const exactType = columnType === "integer" || columnType === "decimal" ? columnType : undefined;
  const hasExactSum = Object.prototype.hasOwnProperty.call(candidate, "exactSum");
  if (hasExactSum && (!exactType || !isExactNumericSummaryCell(candidate.exactSum, exactType))) return false;
  if (valueCount === 0) {
    if (candidate.sum !== 0) return false;
    if (exactType && (!hasExactSum || !isExactNumericZeroCell(candidate.exactSum as CellValue, exactType))) {
      return false;
    }
  }

  const hasExactMin = Object.prototype.hasOwnProperty.call(candidate, "exactMin");
  const hasExactMax = Object.prototype.hasOwnProperty.call(candidate, "exactMax");
  if (!hasExactMin && !hasExactMax) return true;
  if (!hasExactMin || !hasExactMax || (columnType !== "integer" && columnType !== "decimal")) return false;
  if (
    !isExactNumericExtremum(candidate.exactMin, columnType) ||
    !isExactNumericExtremum(candidate.exactMax, columnType)
  ) {
    return false;
  }

  try {
    return compareExactNumericExtremumCells(candidate.exactMin, candidate.exactMax, columnType) <= 0;
  } catch {
    return false;
  }
}

function isExactNumericExtremum(value: unknown, columnType: "integer" | "decimal"): value is CellValue {
  return isExactNumericExtremumCell(value, columnType);
}

function isTextSummary(value: unknown, valueCount: number): boolean {
  const candidate = exactRecord(value, ["emptyCount"], ["minLength", "maxLength", "meanLength"]);
  if (
    candidate === undefined ||
    !isNonNegativeInteger(candidate.emptyCount) ||
    !Number.isInteger(valueCount) ||
    valueCount < 0 ||
    candidate.emptyCount > valueCount
  ) {
    return false;
  }

  const lengthKeys = ["minLength", "maxLength", "meanLength"] as const;
  const presentLengthCount = lengthKeys.filter((key) => Object.prototype.hasOwnProperty.call(candidate, key)).length;
  if (presentLengthCount === 0) {
    return valueCount === 0 && candidate.emptyCount === 0;
  }
  if (presentLengthCount !== lengthKeys.length || valueCount === 0) {
    return false;
  }

  const { minLength, maxLength, meanLength } = candidate;
  if (
    !isNonNegativeInteger(minLength) ||
    !isNonNegativeInteger(maxLength) ||
    !isFiniteNumber(meanLength) ||
    meanLength < 0 ||
    minLength > maxLength ||
    meanLength < minLength ||
    meanLength > maxLength
  ) {
    return false;
  }
  if (candidate.emptyCount > 0 !== (minLength === 0)) {
    return false;
  }
  if (candidate.emptyCount === valueCount) {
    return minLength === 0 && maxLength === 0 && meanLength === 0;
  }
  return maxLength > 0 && meanLength > 0;
}

function isColumnVisualization(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "numeric": {
      const candidate = exactRecord(value, ["kind", "bins"], ["sampled"]);
      return (
        candidate !== undefined && isArrayOf(candidate.bins, isNumericBin) && optional(candidate, "sampled", isBoolean)
      );
    }
    case "categorical": {
      const candidate = exactRecord(value, ["kind", "categories", "otherCount"], ["sampled"]);
      return (
        candidate !== undefined &&
        isArrayOf(candidate.categories, isValueCount) &&
        isNonNegativeInteger(candidate.otherCount) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    case "boolean": {
      const candidate = exactRecord(value, ["kind", "trueCount", "falseCount"], ["sampled"]);
      return (
        candidate !== undefined &&
        isNonNegativeInteger(candidate.trueCount) &&
        isNonNegativeInteger(candidate.falseCount) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    case "datetime": {
      const candidate = exactRecord(value, ["kind"], ["min", "max", "sampled"]);
      return (
        candidate !== undefined &&
        optional(candidate, "min", isNullableString) &&
        optional(candidate, "max", isNullableString) &&
        optional(candidate, "sampled", isBoolean)
      );
    }
    default:
      return false;
  }
}

function isNumericBin(value: unknown): boolean {
  const candidate = exactRecord(value, ["min", "max", "count"]);
  return (
    candidate !== undefined &&
    isFiniteNumber(candidate.min) &&
    isFiniteNumber(candidate.max) &&
    isNonNegativeInteger(candidate.count)
  );
}

function isValueCount(value: unknown): boolean {
  const candidate = exactRecord(value, ["value", "count"], ["selectionValue"]);
  return (
    candidate !== undefined &&
    isString(candidate.value) &&
    isNonNegativeInteger(candidate.count) &&
    optional(candidate, "selectionValue", isTypedSelectionToken)
  );
}

function isTypedSelectionToken(value: unknown): boolean {
  const candidate = exactRecord(value, ["kind", "version", "columnType", "cell"]);
  return (
    candidate !== undefined &&
    candidate.kind === "typedSelection" &&
    candidate.version === 1 &&
    isEnumMember(candidate.columnType, COLUMN_TYPES) &&
    isCellValue(candidate.cell) &&
    isCompatibleTypedSelectionCell(candidate.columnType as string, candidate.cell)
  );
}

function isCompatibleTypedSelectionCell(columnType: string, value: unknown): boolean {
  const cell = value as UnknownRecord;
  if (
    cell.isNull !== false ||
    cell.isNaN !== false ||
    typeof cell.display !== "string" ||
    !hasAtMostViewValueTextCodePoints(cell.display) ||
    !Object.prototype.hasOwnProperty.call(cell, "raw") ||
    !isJsonValue(cell.raw)
  ) {
    return false;
  }
  if (typeof cell.raw === "string" && !hasAtMostViewValueTextCodePoints(cell.raw)) return false;

  const compatibleKinds: Readonly<Record<string, readonly string[]>> = {
    string: ["string", "integer", "number", "infinity", "boolean", "decimal", "datetime", "date", "duration"],
    integer: ["integer"],
    float: ["number", "infinity"],
    decimal: ["decimal"],
    boolean: ["boolean"],
    date: ["date"],
    datetime: ["datetime"],
    duration: ["duration"],
    binary: [],
    list: [],
    struct: [],
    unknown: []
  };
  if (!compatibleKinds[columnType]?.includes(String(cell.kind))) return false;

  switch (cell.kind) {
    case "string":
    case "decimal":
    case "date":
    case "datetime":
      return typeof cell.raw === "string";
    case "integer":
      return (
        (typeof cell.raw === "number" && Number.isSafeInteger(cell.raw)) ||
        (typeof cell.raw === "string" && /^[+-]?\d+$/u.test(cell.raw))
      );
    case "number":
      return typeof cell.raw === "number" && Number.isFinite(cell.raw);
    case "infinity":
      return cell.raw === null && (cell.sign === -1 || cell.sign === 1);
    case "boolean":
      return typeof cell.raw === "boolean";
    case "duration":
      return (
        (typeof cell.raw === "number" && Number.isFinite(cell.raw)) ||
        (typeof cell.raw === "string" && cell.raw.length > 0)
      );
    default:
      return false;
  }
}

function isDatasetStats(value: unknown): boolean {
  const candidate = exactRecord(
    value,
    ["missingCells", "missingRows", "duplicateRows", "missingValuesByColumn"],
    ["duplicateRowsSampleSize"]
  );
  if (candidate === undefined) return false;
  const sampleSize = candidate.duplicateRowsSampleSize;
  return (
    isNonNegativeInteger(candidate.missingCells) &&
    isNonNegativeInteger(candidate.missingRows) &&
    isNonNegativeInteger(candidate.duplicateRows) &&
    (sampleSize === undefined ||
      (isNonNegativeInteger(sampleSize) && sampleSize > 0 && candidate.duplicateRows < sampleSize)) &&
    isArrayOf(candidate.missingValuesByColumn, isMissingValueCount)
  );
}

function isMissingValueCount(value: unknown): boolean {
  const candidate = exactRecord(value, ["column", "count"]);
  return candidate !== undefined && isString(candidate.column) && isNonNegativeInteger(candidate.count);
}

export function isDataDiff(value: unknown, outputSchema?: readonly ColumnSchema[]): value is DataDiff {
  const candidate = exactRecord(value, [
    "addedRows",
    "removedRows",
    "addedColumns",
    "removedColumns",
    "changedCells",
    "cells",
    "truncated"
  ]);
  return (
    candidate !== undefined &&
    isNonNegativeInteger(candidate.addedRows) &&
    isNonNegativeInteger(candidate.removedRows) &&
    isArrayOf(candidate.addedColumns, isString) &&
    isArrayOf(candidate.removedColumns, isString) &&
    isNonNegativeInteger(candidate.changedCells) &&
    isArrayOf(candidate.cells, (cell) => isCellDiff(cell, outputSchema)) &&
    isBoolean(candidate.truncated)
  );
}

function isCellDiff(value: unknown, outputSchema?: readonly ColumnSchema[]): boolean {
  const candidate = exactRecord(value, ["rowNumber", "columnId", "column", "before", "after"]);
  if (!(
    candidate !== undefined &&
    isNonNegativeInteger(candidate.rowNumber) &&
    isNonEmptyString(candidate.columnId) &&
    isString(candidate.column) &&
    (candidate.before === null || isCellValue(candidate.before)) &&
    (candidate.after === null || isCellValue(candidate.after))
  )) {
    return false;
  }
  return (
    outputSchema === undefined ||
    outputSchema.some((column) => column.id === candidate.columnId && column.name === candidate.column)
  );
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optionalKeys: readonly string[] = []
): UnknownRecord | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([...required, ...optionalKeys]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return undefined;
  return value;
}

function isSessionRequest(candidate: UnknownRecord | undefined, kind: string): candidate is UnknownRecord {
  return (
    candidate !== undefined &&
    candidate.kind === kind &&
    isString(candidate.sessionId) &&
    isNonNegativeInteger(candidate.revision)
  );
}

function optional(record: UnknownRecord, key: string, guard: ValueGuard): boolean {
  return !Object.prototype.hasOwnProperty.call(record, key) || guard(record[key]);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSingleCharacter(value: unknown): boolean {
  if (typeof value !== "string" || [...value].length !== 1) return false;
  const codePoint = value.codePointAt(0);
  return codePoint !== undefined && (codePoint < 0xd800 || codePoint > 0xdfff);
}

function isCsvSyntaxCharacter(value: unknown): boolean {
  return isSingleCharacter(value) && value !== "\0" && value !== "\r" && value !== "\n";
}

function isBoundedExportEncoding(value: unknown): boolean {
  return isNonEmptyTrimmedString(value) && [...value].length <= 64;
}

function isNullableString(value: unknown): boolean {
  return value === null || isString(value);
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isByExampleSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && !Object.is(value, -0);
}

function isNonNegativeByExampleSafeInteger(value: unknown): value is number {
  return isByExampleSafeInteger(value) && value >= 0;
}

function isPositiveByExampleSafeInteger(value: unknown): value is number {
  return isByExampleSafeInteger(value) && value >= 1;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1;
}

function isBoundedPageSize(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 10_000;
}

function isBoundedColumnLimit(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 256;
}

function isEnumMember(value: unknown, values: ReadonlySet<string>): value is string {
  return typeof value === "string" && values.has(value);
}

function isOneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function isArrayOf(value: unknown, guard: ValueGuard): boolean {
  return Array.isArray(value) && value.every(guard);
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || isString(value) || isBoolean(value) || isFiniteNumber(value);
}

function isBoundedViewValue(value: unknown): boolean {
  return isJsonValue(value) && (typeof value !== "string" || hasAtMostViewValueTextCodePoints(value));
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  if (value.length <= maximum) return true;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    count += 1;
    if (count > maximum) return false;
  }
  return true;
}

function isSafeJsonNumber(value: unknown): value is number {
  return isFiniteNumber(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value));
}

function isBoundedByExampleScalar(
  value: unknown,
  budget: ByExampleValidationBudget
): value is string | number | boolean | null {
  return (
    (value === null || isBoolean(value) || isSafeJsonNumber(value) || isString(value)) &&
    (typeof value !== "string" || consumeByExampleString(value, budget))
  );
}

function consumeByExampleString(value: string, budget: ByExampleValidationBudget): boolean {
  const byteLength = strictUtf8ByteLength(value, MAX_BY_EXAMPLE_STRING_UTF8_BYTES);
  if (
    byteLength === undefined ||
    byteLength > MAX_BY_EXAMPLE_STRING_UTF8_BYTES ||
    byteLength > budget.remainingTextBytes
  ) {
    return false;
  }
  budget.remainingTextBytes -= byteLength;
  return true;
}

function strictUtf8ByteLength(value: string, maximum: number): number | undefined {
  let byteLength = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      byteLength += 1;
    } else if (codeUnit <= 0x7ff) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return undefined;
      const lowSurrogate = value.charCodeAt(index + 1);
      if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) return undefined;
      byteLength += 4;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return undefined;
    } else {
      byteLength += 3;
    }
    if (byteLength > maximum) return byteLength;
  }
  return byteLength;
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (isJsonScalar(value)) return true;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isRecord(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
