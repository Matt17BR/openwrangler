import { isDeepStrictEqual } from "node:util";
import type {
  DatasetStatsRequest,
  OpenWranglerResponse,
  PageRequest,
  SummaryRequest,
  ValuesRequest
} from "../../shared/protocol";
import type { BridgeRequestOptions } from "../dataBridge";
import { R_FRAME_CONTRACT_LIMITS } from "./rFrameContract";
import {
  gridPageFromRContract as gridPageFromContract,
  rPageWindow as pageWindow,
  validateRPageWindow as validatePageWindow
} from "./rKernelFrameMapping";
import {
  assertSessionContract,
  copyFilterModel,
  diagnosticResponse,
  errorResponse,
  kernelChangedError,
  metadataFor,
  staleResponseError,
  staleRevisionError,
  transportOptions,
  unknownSessionError,
  validateProfileRequest,
  type RBridgeSession
} from "./rKernelBridgeContract";
import type { RKernelColumnReference, RKernelViewQuery } from "./rKernelProtocol";
import { RKernelDiagnosticError } from "./rKernelTransport";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import {
  assertRColumnValuesContract as assertColumnValuesContract,
  assertRDatasetStatsContract as assertDatasetStatsContract,
  assertRSummaryContract as assertSummaryContract,
  resolveNamedRColumn as resolveNamedColumn,
  resolveRProfileColumns as resolveProfileColumns,
  resolveRViewQuery as resolveViewQuery
} from "./rKernelViewContract";
import { assertCustomDerivedRowIdentities } from "./rKernelMutationSchema";

export type RKernelReadTransport = Pick<
  RKernelBridgeTransport,
  "getPage" | "getSummary" | "getDatasetStats" | "getColumnValues"
>;

export class RKernelReadQueries {
  constructor(
    private readonly transport: RKernelReadTransport,
    private readonly sessions: ReadonlyMap<string, RBridgeSession>
  ) {}

  async getPage(request: PageRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
    if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
    const stale = staleRevisionError(session, request.revision, request.viewRequestId);
    if (stale) return stale;
    const expectedRevision = session.revision;
    const expectedSchema = session.schema;
    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(request.filterModel, session.schema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_view",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    try {
      const contract = await this.transport.getPage(
        request.sessionId,
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view),
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (session.revision !== expectedRevision || session.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertSessionContract(
        session,
        contract,
        request,
        expectedSchema,
        session.rows,
        session.identityRows,
        session.keyColumnIds,
        session.rowNames,
        view
      );
      assertCustomDerivedRowIdentities(contract, session.customRowIdentities, view);
      const nextFilterModel = copyFilterModel(request.filterModel);
      if (!isDeepStrictEqual(session.filterModel, nextFilterModel)) session.viewChangeEpoch += 1;
      session.filterModel = nextFilterModel;
      return {
        kind: "page",
        revision: session.revision,
        viewRequestId: request.viewRequestId,
        page: gridPageFromContract(contract),
        metadata: metadataFor(session, contract.page.totalRows)
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  async getSummary(request: SummaryRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateProfileRequest(request, session);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    const requestedIds = request.columnIds ?? confirmed.schema.map((column) => column.id);
    if (requestedIds.length === 0) {
      return { kind: "summary", revision: confirmed.revision, viewRequestId: request.viewRequestId, summaries: [] };
    }
    if (requestedIds.length > R_FRAME_CONTRACT_LIMITS.profileColumns) {
      return errorResponse(
        "profile_too_large",
        `R profile requests may contain at most ${R_FRAME_CONTRACT_LIMITS.profileColumns} columns.`,
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    let columns: readonly RKernelColumnReference[];
    let view: RKernelViewQuery;
    try {
      columns = resolveProfileColumns(requestedIds, confirmed.schema);
      view = resolveViewQuery(request.filterModel, confirmed.schema);
    } catch (error) {
      return errorResponse(
        "invalid_view",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    try {
      const summaries = await this.transport.getSummary(request.sessionId, columns, view, transportOptions(options));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertSummaryContract(confirmed, columns, summaries, view);
      return {
        kind: "summary",
        revision: confirmed.revision,
        viewRequestId: request.viewRequestId,
        summaries: summaries.map((summary) => ({ ...summary }))
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  async getDatasetStats(request: DatasetStatsRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateProfileRequest(request, session);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(request.filterModel, confirmed.schema);
    } catch (error) {
      return errorResponse(
        "invalid_view",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    try {
      const result = await this.transport.getDatasetStats(request.sessionId, view, transportOptions(options));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertDatasetStatsContract(confirmed, result, view);
      return {
        kind: "datasetStats",
        revision: confirmed.revision,
        viewRequestId: request.viewRequestId,
        stats: {
          ...result.stats,
          missingValuesByColumn: result.stats.missingValuesByColumn.map((entry) => ({ ...entry }))
        }
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }

  async getColumnValues(request: ValuesRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId, request.viewRequestId);
    if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
    const stale = staleRevisionError(session, request.revision, request.viewRequestId);
    if (stale) return stale;
    const expectedRevision = session.revision;
    const expectedSchema = session.schema;

    let column: RKernelColumnReference;
    let view: RKernelViewQuery;
    try {
      column = resolveNamedColumn(request.column, session.schema, "values");
      view = resolveViewQuery(request.filterModel, session.schema);
    } catch (error) {
      return errorResponse(
        "invalid_view",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId,
        request.viewRequestId
      );
    }

    try {
      const result = await this.transport.getColumnValues(
        request.sessionId,
        column,
        view,
        request.search,
        request.limit,
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (session.revision !== expectedRevision || session.schema !== expectedSchema) {
        return staleResponseError(request.sessionId, request.viewRequestId);
      }
      assertColumnValuesContract(session, column, result, request.limit, request.search);
      return {
        kind: "columnValues",
        revision: session.revision,
        viewRequestId: request.viewRequestId,
        column: result.column,
        values: result.values.map((entry) => ({ ...entry })),
        hasMore: result.hasMore,
        ...(result.sampleSize === undefined ? {} : { sampleSize: result.sampleSize })
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId, request.viewRequestId);
      if (error instanceof RKernelDiagnosticError) {
        return diagnosticResponse(error, request.sessionId, request.viewRequestId);
      }
      throw error;
    }
  }
}
