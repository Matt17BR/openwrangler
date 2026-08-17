import { isDeepStrictEqual } from "node:util";
import type { ColumnSchema, InspectStepRequest, OpenWranglerResponse, RowAxis } from "../../shared/protocol";
import type { BridgeRequestOptions } from "../dataBridge";
import type { RColumnSchema, RFramePageContract } from "./rFrameContract";
import {
  assertMutationContract,
  diagnosticResponse,
  errorResponse,
  kernelChangedError,
  staleResponseError,
  staleRevisionError,
  transportOptions,
  unknownSessionError,
  type RBridgeSession
} from "./rKernelBridgeContract";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import {
  copyRSchema as copySchema,
  emptyRViewQuery,
  gridPageFromRContract as gridPageFromContract,
  rPageWindow as pageWindow,
  sameRSchema as sameSchema,
  validateRPageWindow as validatePageWindow
} from "./rKernelFrameMapping";
import { RKernelDiagnosticError } from "./rKernelTransport";
import { assertMutationDiff, copyDiff, inspectionDiff } from "./rKernelMutationDiff";
import { assertCustomDerivedRowIdentities, customRowIdentityConstraintAfterRStep } from "./rKernelMutationSchema";
import type { RTransformStep } from "./rKernelTransformBinding";

export class RKernelStepInspection {
  constructor(
    private readonly transport: Pick<RKernelBridgeTransport, "inspectStep">,
    private readonly sessions: ReadonlyMap<string, RBridgeSession>
  ) {}

  async inspectStep(request: InspectStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    if (!session) return unknownSessionError(request.sessionId);
    if (session.invalidated) return kernelChangedError(request.sessionId);
    const stale = staleRevisionError(session, request.revision);
    if (stale) return stale;
    const stepIndex = session.steps.findIndex((step) => step.id === request.stepId);
    if (stepIndex < 0 || session.steps.filter((step) => step.id === request.stepId).length !== 1) {
      return errorResponse("invalid_request", "The requested R cleaning step is not applied.", true, request.sessionId);
    }
    try {
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }
    const inputSchema = session.planInputSchemas[stepIndex] as readonly ColumnSchema[];
    const inputRSchema = session.planInputRSchemas[stepIndex] as readonly RColumnSchema[];
    const inputRows = session.planInputRows[stepIndex];
    if (inputRows === undefined) throw new Error("The R bridge is missing an applied-step input row count.");
    const inputIdentityRows = session.planInputIdentityRows[stepIndex];
    if (inputIdentityRows === undefined) {
      throw new Error("The R bridge is missing an applied-step input row-identity domain.");
    }
    const inputKeyColumnIds = session.planInputKeyColumnIds[stepIndex];
    if (!inputKeyColumnIds) throw new Error("The R bridge is missing applied-step input key metadata.");
    const inputRowNames = session.planInputRowNames[stepIndex];
    if (inputRowNames === undefined) throw new Error("The R bridge is missing applied-step input row-name metadata.");
    const inputCustomRowIdentities = session.planInputCustomRowIdentities[stepIndex];
    const appliedStep = session.steps[stepIndex] as RTransformStep;
    const outputSchema =
      session.planInputSchemas[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedSchema : undefined);
    if (!outputSchema) throw new Error("The R bridge is missing an applied-step output schema.");
    const outputRSchema =
      session.planInputRSchemas[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRSchema : undefined);
    if (!outputRSchema) throw new Error("The R bridge is missing an applied-step output R schema.");
    const outputRows =
      session.planInputRows[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRows : undefined);
    if (outputRows === undefined) throw new Error("The R bridge is missing an applied-step output row count.");
    const outputCustomRowIdentities = customRowIdentityConstraintAfterRStep(
      appliedStep,
      inputCustomRowIdentities,
      inputIdentityRows,
      outputRows
    );
    const outputIdentityRows =
      session.planInputIdentityRows[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedIdentityRows : undefined);
    if (outputIdentityRows === undefined) {
      throw new Error("The R bridge is missing an applied-step output row-identity domain.");
    }
    const outputKeyColumnIds =
      session.planInputKeyColumnIds[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedKeyColumnIds : undefined);
    if (!outputKeyColumnIds) throw new Error("The R bridge is missing applied-step output key metadata.");
    const outputRowNames =
      session.planInputRowNames[stepIndex + 1] ??
      (stepIndex === session.steps.length - 1 ? session.committedRowNames : undefined);
    if (outputRowNames === undefined) throw new Error("The R bridge is missing applied-step output row-name metadata.");
    const expectedRevision = session.revision;
    const page = pageWindow(
      request.offset,
      request.limit,
      request.columnOffset,
      request.columnLimit,
      emptyRViewQuery()
    );
    try {
      const result = await this.transport.inspectStep(
        request.sessionId,
        expectedRevision,
        request.stepId,
        page,
        inputRSchema,
        outputRSchema,
        transportOptions(options)
      );
      if (session.invalidated) return kernelChangedError(request.sessionId);
      if (
        result.sessionId !== request.sessionId ||
        result.revision !== expectedRevision ||
        result.stepId !== request.stepId
      ) {
        throw new Error("The R kernel returned a mismatched applied-step inspection.");
      }
      if (session.revision !== expectedRevision) return staleResponseError(request.sessionId);
      if (result.stepIndex !== stepIndex || result.stepId !== request.stepId) {
        throw new Error("The R kernel inspected a different cleaning step.");
      }
      assertMutationContract(
        session,
        result.inputPage,
        request,
        inputSchema,
        inputRows,
        inputIdentityRows,
        inputKeyColumnIds,
        inputRowNames,
        emptyRViewQuery()
      );
      assertCustomDerivedRowIdentities(result.inputPage, inputCustomRowIdentities, emptyRViewQuery());
      assertMutationContract(
        session,
        result.outputPage,
        request,
        outputSchema,
        outputRows,
        outputIdentityRows,
        outputKeyColumnIds,
        outputRowNames,
        emptyRViewQuery()
      );
      assertCustomDerivedRowIdentities(result.outputPage, outputCustomRowIdentities, emptyRViewQuery());
      if (
        !sameSchema(inputSchema, result.inputSchema) ||
        !sameSchema(outputSchema, result.outputSchema) ||
        !isDeepStrictEqual(inputRSchema, result.inputSchema) ||
        !isDeepStrictEqual(outputRSchema, result.outputSchema)
      ) {
        throw new Error("The R kernel returned mismatched applied-step schemas.");
      }
      const diff = inspectionDiff(
        appliedStep,
        inputSchema,
        outputSchema,
        result.inputPage,
        result.outputPage,
        inputRows,
        outputRows
      );
      assertMutationDiff(
        appliedStep,
        inputSchema,
        outputSchema,
        inputRows,
        outputRows,
        result.outputPage,
        diff,
        emptyRViewQuery()
      );
      return {
        kind: "stepInspection",
        revision: session.revision,
        stepId: request.stepId,
        stepIndex,
        inputPage: gridPageFromContract(result.inputPage),
        outputPage: gridPageFromContract(result.outputPage),
        inputSchema: copySchema(inputSchema),
        outputSchema: copySchema(outputSchema),
        inputRowAxis: rowAxisFromRRowNames(inputRowNames),
        outputRowAxis: rowAxisFromRRowNames(outputRowNames),
        diff: copyDiff(diff),
        code: result.code
      };
    } catch (error) {
      if (session.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      throw error;
    }
  }
}

function rowAxisFromRRowNames(rowNames: RFramePageContract["frameSemantics"]["rowNames"]): RowAxis {
  return rowNames === "explicit" ? { kind: "index", levelNames: [null] } : { kind: "positional", levelNames: [] };
}
