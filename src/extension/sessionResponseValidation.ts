import { isDeepStrictEqual } from "node:util";
import type {
  ColumnSchema,
  DataDiff,
  LiveGridPage,
  OpenSessionRequest,
  OpenWranglerResponse,
  SessionBoundRequest,
  SessionMetadata,
  SessionOpenedResponse
} from "../shared/protocol";
import { requestViewId } from "./sessionRequestScheduler";

export function responseMismatch(
  request: SessionBoundRequest,
  response: OpenWranglerResponse,
  runtimeSessionId: string,
  confirmedPageSchema?: readonly ColumnSchema[]
): string | undefined {
  const expectedViewRequestId = requestViewId(request);
  if (response.kind === "error") {
    if (response.sessionId !== undefined && response.sessionId !== runtimeSessionId) {
      return `error named runtime session ${response.sessionId} instead of ${runtimeSessionId}`;
    }
    if (expectedViewRequestId !== undefined && response.viewRequestId !== expectedViewRequestId) {
      return `error did not retain view request ${expectedViewRequestId}`;
    }
    return undefined;
  }
  if (response.kind === "cancelled") {
    if (expectedViewRequestId !== undefined && response.viewRequestId !== expectedViewRequestId) {
      return `cancellation did not retain view request ${expectedViewRequestId}`;
    }
    return undefined;
  }

  switch (request.kind) {
    case "getPage": {
      if (response.kind !== "page") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "page correlation did not match";
      if (response.revision !== request.revision) {
        return `page revision ${response.revision} did not match ${request.revision}`;
      }
      const pageMetadataMismatch = metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId);
      if (pageMetadataMismatch) return pageMetadataMismatch;
      if (confirmedPageSchema && !isDeepStrictEqual(response.metadata.schema, confirmedPageSchema)) {
        return "page metadata schema changed without a revision";
      }
      return projectedPageMismatch(response.page, confirmedPageSchema ?? response.metadata.schema, request);
    }
    case "getSummary":
      if (response.kind !== "summary") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "summary correlation did not match";
      if (response.revision !== request.revision) {
        return `summary revision ${response.revision} did not match ${request.revision}`;
      }
      return summaryProjectionMismatch(response.summaries, confirmedPageSchema, request.columnIds);
    case "getDatasetStats":
      if (response.kind !== "datasetStats") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "dataset-statistics correlation did not match";
      return response.revision === request.revision
        ? undefined
        : `dataset-statistics revision ${response.revision} did not match ${request.revision}`;
    case "getColumnValues":
      if (response.kind !== "columnValues") return `runtime returned ${response.kind}`;
      if (response.viewRequestId !== request.viewRequestId) return "column-values correlation did not match";
      if (response.column !== request.column) return `runtime returned values for ${response.column}`;
      return response.revision === request.revision
        ? undefined
        : `column-values revision ${response.revision} did not match ${request.revision}`;
    case "previewStep":
      if (response.kind !== "stepPreview") return `runtime returned ${response.kind}`;
      if (response.revision !== request.revision + 1) {
        return `preview revision ${response.revision} did not follow ${request.revision}`;
      }
      return (
        metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId) ??
        projectedPageMismatch(response.page, response.metadata.schema, request) ??
        dataDiffSchemaMismatch(response.diff, response.metadata.schema)
      );
    case "inspectStep":
      if (response.kind !== "stepInspection") return `runtime returned ${response.kind}`;
      if (response.stepId !== request.stepId) {
        return `runtime inspected step ${response.stepId} instead of ${request.stepId}`;
      }
      if (response.revision !== request.revision) {
        return `inspection revision ${response.revision} did not match ${request.revision}`;
      }
      return (
        projectedPageMismatch(response.inputPage, response.inputSchema, request, "inspection input page") ??
        projectedPageMismatch(response.outputPage, response.outputSchema, request, "inspection output page") ??
        dataDiffSchemaMismatch(response.diff, response.outputSchema)
      );
    case "applyDraft":
    case "discardDraft":
    case "undoStep": {
      if (response.kind !== "planUpdated") return `runtime returned ${response.kind}`;
      const expectedAction =
        request.kind === "applyDraft" ? "apply" : request.kind === "discardDraft" ? "discard" : "undo";
      if (response.action !== expectedAction) {
        return `runtime reported ${response.action} instead of ${expectedAction}`;
      }
      if (response.revision !== request.revision + 1) {
        return `plan revision ${response.revision} did not follow ${request.revision}`;
      }
      return (
        metadataResponseMismatch(response.metadata, response.revision, runtimeSessionId) ??
        projectedPageMismatch(response.page, response.metadata.schema, request)
      );
    }
    case "exportData":
      if (response.kind !== "dataExported") return `runtime returned ${response.kind}`;
      if (response.format !== request.options.format) return `runtime reported ${response.format} export`;
      if (response.path !== request.path) return "runtime reported a different export path";
      return response.revision === request.revision
        ? undefined
        : `export revision ${response.revision} did not match ${request.revision}`;
    case "closeSession":
      if (response.kind !== "sessionClosed") return `runtime returned ${response.kind}`;
      return response.sessionId === runtimeSessionId
        ? undefined
        : `runtime acknowledged session ${response.sessionId} instead of ${runtimeSessionId}`;
  }
}

export function sessionOpenedResponseMismatch(
  request: OpenSessionRequest,
  response: SessionOpenedResponse,
  strictIdentity = false
): string | undefined {
  if (strictIdentity && request.requestedSessionId && response.metadata.sessionId !== request.requestedSessionId) {
    return `metadata named runtime session ${response.metadata.sessionId} instead of requested session ${request.requestedSessionId}`;
  }
  if (request.backend && response.metadata.backend !== request.backend) {
    return `metadata reported backend ${response.metadata.backend} instead of requested backend ${request.backend}`;
  }
  if (strictIdentity && request.mode && response.metadata.mode !== request.mode) {
    return `metadata reported mode ${response.metadata.mode} instead of requested mode ${request.mode}`;
  }
  if (!isDeepStrictEqual(response.metadata.source, request.source)) {
    return "metadata reported a different immutable source";
  }
  if (response.metadata.revision < 0 || !Number.isSafeInteger(response.metadata.revision)) {
    return `metadata reported invalid revision ${response.metadata.revision}`;
  }
  if (response.page.offset !== 0) return `page offset ${response.page.offset} did not match 0`;
  if (response.page.limit !== request.pageSize) {
    return `page limit ${response.page.limit} did not match ${request.pageSize}`;
  }
  return projectedPageMismatch(response.page, response.metadata.schema, {
    offset: 0,
    limit: request.pageSize,
    columnOffset: request.columnOffset,
    columnLimit: request.columnLimit
  });
}

function summaryProjectionMismatch(
  summaries: Extract<OpenWranglerResponse, { kind: "summary" }>["summaries"],
  schema: readonly ColumnSchema[] | undefined,
  requestedColumnIds: readonly string[] | undefined
): string | undefined {
  if (!schema) return "summary validation is missing the confirmed schema";
  const schemaById = new Map(schema.map((column) => [column.id, column]));
  const expectedIds = requestedColumnIds ?? schema.map((column) => column.id);
  const returnedIds = summaries.map((summary) => summary.columnId);
  if (!isDeepStrictEqual(returnedIds, expectedIds) || new Set(returnedIds).size !== returnedIds.length) {
    return "summary column identities did not match the requested projection";
  }
  for (const summary of summaries) {
    const column = schemaById.get(summary.columnId);
    if (
      !column ||
      summary.column !== column.name ||
      summary.type !== column.type ||
      summary.rawType !== column.rawType
    ) {
      return `summary for ${summary.columnId} did not match the confirmed schema`;
    }
  }
  return undefined;
}

function projectedPageMismatch(
  page: LiveGridPage,
  schema: readonly ColumnSchema[],
  request: { offset: number; limit: number; columnOffset: number; columnLimit: number },
  label = "page"
): string | undefined {
  if (page.offset !== request.offset) return `${label} offset ${page.offset} did not match ${request.offset}`;
  if (page.limit !== request.limit) return `${label} limit ${page.limit} did not match ${request.limit}`;
  const expectedColumnIds = schema
    .slice(request.columnOffset, request.columnOffset + request.columnLimit)
    .map((column) => column.id);
  if (!isDeepStrictEqual(page.columnIds, expectedColumnIds)) {
    return `${label} column identities did not match the requested projection`;
  }
  if (page.rows.length > request.limit) return `${label} returned more than ${request.limit} rows`;
  if (page.rows.some((row) => row.values.length !== expectedColumnIds.length)) {
    return `${label} row width did not match its projected column identities`;
  }
  return undefined;
}

function dataDiffSchemaMismatch(diff: DataDiff, outputSchema: readonly ColumnSchema[]): string | undefined {
  for (const cell of diff.cells) {
    const column = outputSchema.find((candidate) => candidate.id === cell.columnId);
    if (!column) return `diff cell named unknown output column identity ${cell.columnId}`;
    if (column.name !== cell.column) {
      return `diff cell label ${cell.column} did not match output column ${column.name}`;
    }
  }
  return undefined;
}

function metadataResponseMismatch(
  metadata: SessionMetadata,
  responseRevision: number,
  runtimeSessionId: string
): string | undefined {
  if (metadata.sessionId !== runtimeSessionId) {
    return `metadata named runtime session ${metadata.sessionId} instead of ${runtimeSessionId}`;
  }
  if (metadata.revision !== responseRevision) {
    return `metadata revision ${metadata.revision} did not match response revision ${responseRevision}`;
  }
  return undefined;
}
