import { isDeepStrictEqual } from "node:util";
import { reconcileViewFilterModel } from "../../shared/filterModel";
import {
  type ColumnSchema,
  type ConfirmedView,
  type FilterModel,
  type OpenWranglerRequest,
  type OpenWranglerResponse,
  type PreviewStepRequest,
  type RedoStepRequest,
  type TransformStep,
  type RetainedTransformStep
} from "../../shared/protocol";
import { isConfirmedView } from "../../shared/protocolValidation";
import type { BridgeRequestOptions } from "../dataBridge";
import { RKernelDiagnosticError } from "./rKernelTransport";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import { type RKernelTransformStep, type RKernelViewQuery } from "./rKernelProtocol";
import type { RColumnSchema, RDataframeFlavor, RFramePageContract } from "./rFrameContract";
import {
  R_BRIDGE_CAPABILITIES,
  assertMutationContract,
  clearDraft,
  copyFilterModel,
  diagnosticResponse,
  errorResponse,
  kernelChangedError,
  metadataFor,
  staleResponseError,
  transportOptions,
  validateMutationRequest,
  type RBridgeSession
} from "./rKernelBridgeContract";
import {
  copyRSchema as copySchema,
  gridPageFromRContract as gridPageFromContract,
  rPageWindow as pageWindow,
  schemaFromRContract as schemaFromContract,
  validateRPageWindow as validatePageWindow
} from "./rKernelFrameMapping";
import { rTransformStep, type RPreviewTransformStep, type RTransformStep } from "./rKernelTransformBinding";
import {
  assertMutationDiff,
  categoricalRetainedSchema,
  copyDiff,
  isRCategoricalTransformStep
} from "./rKernelMutationDiff";
import {
  acceptRetainedByExampleStep,
  assertRPivotLongerPreflight,
  assertRPivotWiderPreflight,
  assertCustomDerivedRowIdentities,
  customRowIdentityConstraintAfterRStep,
  dynamicByExampleSchema,
  dynamicCategoricalSchema,
  dynamicCustomCodeSchema,
  keyColumnsAfterRStep,
  rowCountAfterRStep,
  rowIdentityDomainAfterRStep,
  rowNamesAfterRStep,
  schemaAfterRStep,
  schemaAfterNestedStep,
  type RCustomRowIdentityConstraint
} from "./rKernelMutationSchema";
import { copyRTransformStep } from "./rKernelTransformState";
import { resolveRViewQuery as resolveViewQuery } from "./rKernelViewContract";

function isSupportedRStep(step: TransformStep): step is RPreviewTransformStep {
  return R_BRIDGE_CAPABILITIES.supportedOperations?.includes(step.kind) === true;
}

/**
 * Owns native-R preview and cleaning-plan mutations against confirmed bridge
 * sessions while preserving the bridge's exact transport correlation rules.
 */
export class RKernelMutationLifecycle {
  constructor(
    private readonly transport: RKernelBridgeTransport,
    private readonly sessions: Map<string, RBridgeSession>
  ) {}

  previewStep(request: PreviewStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    return this.executeStep(request, request.step, options);
  }

  async redoStep(request: RedoStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    const saved = session?.redoSteps.at(-1);
    const result =
      invalid ??
      (saved
        ? await this.executeStep(request, saved, options)
        : errorResponse("redo_unavailable", "There is no R step to redo in this session.", true, request.sessionId));
    if (result.kind === "error") {
      if (result.code === "redo_unavailable" && session) session.redoSteps = [];
      return { ...result, viewRequestId: request.viewRequestId };
    }
    return result;
  }

  private async executeStep(
    request: PreviewStepRequest | RedoStepRequest,
    step: TransformStep,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const replaceStepId = request.kind === "previewStep" ? request.replaceStepId : undefined;
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    let currentView: ConfirmedView;
    try {
      currentView = confirmedMutationView(confirmed, options);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    if (confirmed.draftStep) {
      return errorResponse(
        "invalid_request",
        "Apply or discard the current R draft before previewing another step.",
        true,
        request.sessionId
      );
    }
    if (!isSupportedRStep(step)) {
      return errorResponse(
        "unsupported_operation",
        "The native R runtime does not support this operation.",
        true,
        request.sessionId
      );
    }

    let inputSchema: readonly ColumnSchema[];
    let inputRSchema: readonly RColumnSchema[];
    let inputRows: number;
    let inputIdentityRows: number;
    let inputKeyColumnIds: readonly string[];
    let inputRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    let inputDataframeFlavor: RDataframeFlavor;
    let inputCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
    if (replaceStepId !== undefined) {
      const matches = confirmed.steps.flatMap((step, index) => (step.id === replaceStepId ? [index] : []));
      if (matches.length !== 1 || step.id !== replaceStepId) {
        return errorResponse(
          "invalid_request",
          matches.length === 0
            ? "The selected applied R step no longer exists."
            : matches.length > 1
              ? "Applied R step IDs must be unique."
              : "An edited R step must retain its step ID.",
          true,
          request.sessionId
        );
      }
      const replaceIndex = matches[0];
      inputSchema = confirmed.planInputSchemas[replaceIndex] ?? confirmed.sourceSchema;
      inputRSchema = confirmed.planInputRSchemas[replaceIndex] ?? confirmed.sourceRSchema;
      inputRows = confirmed.planInputRows[replaceIndex] ?? confirmed.sourceRows;
      inputIdentityRows = confirmed.planInputIdentityRows[replaceIndex] ?? confirmed.sourceRows;
      inputKeyColumnIds = confirmed.planInputKeyColumnIds[replaceIndex] ?? confirmed.sourceKeyColumnIds;
      inputRowNames = confirmed.planInputRowNames[replaceIndex] ?? confirmed.sourceRowNames;
      inputDataframeFlavor = confirmed.planInputDataframeFlavors[replaceIndex] ?? confirmed.sourceDataframeFlavor;
      inputCustomRowIdentities = confirmed.planInputCustomRowIdentities[replaceIndex];
    } else {
      if (confirmed.steps.some((applied) => applied.id === step.id)) {
        return errorResponse("invalid_request", "Applied R step IDs must be unique.", true, request.sessionId);
      }
      inputSchema = confirmed.committedSchema;
      inputRSchema = confirmed.committedRSchema;
      inputRows = confirmed.committedRows;
      inputIdentityRows = confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.committedKeyColumnIds;
      inputRowNames = confirmed.committedRowNames;
      inputDataframeFlavor = confirmed.committedDataframeFlavor;
      inputCustomRowIdentities = confirmed.committedCustomRowIdentities;
    }

    let targetSchema: readonly ColumnSchema[];
    let targetKeyColumnIds: readonly string[];
    let nextFilterModel: FilterModel;
    let view: RKernelViewQuery;
    let rStep: RKernelTransformStep;
    let retainedStep: RTransformStep;
    try {
      targetSchema =
        step.kind === "byExample" || step.kind === "customCode"
          ? Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })))
          : isRCategoricalTransformStep(step)
            ? categoricalRetainedSchema(inputSchema, step)
            : schemaAfterRStep(inputSchema, step, inputKeyColumnIds, inputRSchema);
      if (step.kind === "pivotLonger") {
        assertRPivotLongerPreflight(step, inputSchema, inputRSchema, inputRows);
      }
      if (step.kind === "pivotWider") {
        assertRPivotWiderPreflight(step, inputSchema, inputRSchema, inputRows);
      }
      targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, step);
      rStep = rTransformStep(step, inputSchema);
      nextFilterModel =
        step.kind === "customCode"
          ? copyFilterModel(currentView.filterModel)
          : reconcileViewFilterModel(currentView.filterModel, confirmed.schema, targetSchema, "id");
      view = resolveViewQuery(nextFilterModel, step.kind === "customCode" ? confirmed.schema : targetSchema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    confirmed.filterModel = currentView.filterModel;
    confirmed.viewChangeEpoch = currentView.viewChangeEpoch;
    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    const draftBaseFilterModel = copyFilterModel(confirmed.filterModel);
    const draftBaseViewChangeEpoch = confirmed.viewChangeEpoch;
    try {
      const page = pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view);
      const result = await (request.kind === "redoStep"
        ? this.transport.redoStep(
            request.sessionId,
            expectedRevision,
            rStep,
            page,
            inputRSchema,
            transportOptions(options)
          )
        : this.transport.previewStep(
            request.sessionId,
            expectedRevision,
            rStep,
            page,
            inputRSchema,
            replaceStepId,
            transportOptions(options)
          ));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (result.sessionId !== request.sessionId || result.revision !== expectedRevision + 1) {
        throw new Error("The R kernel returned a mismatched step preview.");
      }
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        confirmed.invalidated = true;
        return staleResponseError(request.sessionId);
      }
      if ((step.kind === "customCode") !== (result.effectiveView !== undefined)) {
        throw new Error("The R kernel returned an effective view for the wrong draft operation.");
      }
      if (step.kind === "extractStructFields" || step.kind === "explodeList") {
        if (!isDeepStrictEqual(result.page.schema, schemaAfterNestedStep(inputRSchema, step)))
          throw new Error("The R kernel changed exact nested output or sibling metadata.");
      }
      if (isRCategoricalTransformStep(step)) {
        targetSchema = dynamicCategoricalSchema(inputSchema, inputRSchema, step, result.page);
        targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, step);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, view)) {
          throw new Error("The R categorical schema changed the pre-dispatch viewing query.");
        }
      }
      if (step.kind === "customCode") {
        const effectiveView = result.effectiveView;
        if (effectiveView === undefined) {
          throw new Error("The R custom-code preview omitted its effective view.");
        }
        if (result.retainedStep !== undefined) {
          throw new Error("The R kernel returned a retained step for the wrong draft operation.");
        }
        retainedStep = copyRTransformStep(step);
        targetSchema = dynamicCustomCodeSchema(inputSchema, step, result.page);
        targetKeyColumnIds = Object.freeze([...result.page.frameSemantics.keyColumnIds]);
        nextFilterModel = reconcileViewFilterModel(confirmed.filterModel, confirmed.schema, targetSchema, "id");
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, effectiveView)) {
          throw new Error("The R custom-code preview returned a mismatched effective view.");
        }
        view = effectiveView;
      } else if (step.kind === "byExample") {
        retainedStep = acceptRetainedByExampleStep(result.retainedStep, rStep, inputSchema);
        targetSchema = dynamicByExampleSchema(inputSchema, inputRSchema, retainedStep, result.page);
        targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, retainedStep);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, view)) {
          throw new Error("The R by-example schema changed the pre-dispatch viewing query.");
        }
      } else {
        if (result.retainedStep !== undefined) {
          throw new Error("The R kernel returned a retained step for the wrong draft operation.");
        }
        retainedStep = copyRTransformStep(step);
      }
      const targetRows = rowCountAfterRStep(step, inputRows, result.diff);
      const targetDataframeFlavor = step.kind === "customCode" ? result.page.dataframeFlavor : inputDataframeFlavor;
      const targetRowNames =
        step.kind === "customCode"
          ? result.page.frameSemantics.rowNames
          : rowNamesAfterRStep(inputRowNames, step, inputDataframeFlavor, targetRows);
      const targetIdentityRows = rowIdentityDomainAfterRStep(step, inputIdentityRows, targetRows);
      const targetCustomRowIdentities = customRowIdentityConstraintAfterRStep(
        step,
        inputCustomRowIdentities,
        inputIdentityRows,
        targetRows
      );
      assertMutationContract(
        confirmed,
        result.page,
        request,
        targetSchema,
        targetRows,
        targetIdentityRows,
        targetKeyColumnIds,
        targetRowNames,
        view,
        step.kind === "castColumn"
          ? { columnId: step.params.column.id, mode: "mayAdd" }
          : step.kind === "minMaxScale"
            ? {
                columnId:
                  step.params.newColumn === undefined || step.params.newColumn === step.params.column.name
                    ? step.params.column.id
                    : `c:step:${step.id}:0`,
                mode: "mayAdd"
              }
            : step.kind === "splitText" || step.kind === "denseRank"
              ? { columnId: `c:step:${step.id}:0`, mode: "mayAdd" }
              : step.kind === "fillMissingValues" && step.params.replacement.kind === "fallbackColumns"
                ? { columnId: step.params.column.id, mode: "mayRemove" }
                : undefined,
        targetDataframeFlavor
      );
      assertMutationDiff(
        retainedStep,
        inputSchema,
        targetSchema,
        inputRows,
        targetRows,
        result.page,
        result.diff,
        view
      );
      assertCustomDerivedRowIdentities(result.page, targetCustomRowIdentities, view);
      if ((step.kind === "fillMissingValues") !== (result.remainingMissingCells !== undefined)) {
        throw new Error("The R kernel returned a missing-value count for the wrong draft operation.");
      }
      if (result.remainingMissingCells !== undefined && result.remainingMissingCells > targetRows) {
        throw new Error("The R kernel returned more missing values than rows in the dataframe.");
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.rSchema = result.page.schema;
      confirmed.rows = targetRows;
      confirmed.identityRows = targetIdentityRows;
      confirmed.keyColumnIds = Object.freeze([...targetKeyColumnIds]);
      confirmed.customRowIdentities = targetCustomRowIdentities;
      confirmed.rowNames = targetRowNames;
      confirmed.dataframeFlavor = targetDataframeFlavor;
      confirmed.filterModel = nextFilterModel;
      if (request.kind === "redoStep") {
        confirmed.steps = [...confirmed.steps, copyRTransformStep(retainedStep)];
        confirmed.planInputSchemas = [...confirmed.planInputSchemas, copySchema(inputSchema)];
        confirmed.planInputRSchemas = [...confirmed.planInputRSchemas, inputRSchema];
        confirmed.planInputRows = [...confirmed.planInputRows, inputRows];
        confirmed.planInputIdentityRows = [...confirmed.planInputIdentityRows, inputIdentityRows];
        confirmed.planInputKeyColumnIds = [...confirmed.planInputKeyColumnIds, Object.freeze([...inputKeyColumnIds])];
        confirmed.planInputRowNames = [...confirmed.planInputRowNames, inputRowNames];
        confirmed.planInputDataframeFlavors = [...confirmed.planInputDataframeFlavors, inputDataframeFlavor];
        confirmed.planInputCustomRowIdentities = [...confirmed.planInputCustomRowIdentities, inputCustomRowIdentities];
        confirmed.committedSchema = confirmed.schema;
        confirmed.committedRSchema = confirmed.rSchema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = confirmed.keyColumnIds;
        confirmed.committedRowNames = targetRowNames;
        confirmed.committedDataframeFlavor = targetDataframeFlavor;
        confirmed.committedCustomRowIdentities = targetCustomRowIdentities;
        confirmed.redoSteps = confirmed.redoSteps.slice(0, -1);
        confirmed.lastAppliedViewRestore =
          confirmed.viewChangeEpoch === draftBaseViewChangeEpoch
            ? {
                stepId: retainedStep.id,
                before: draftBaseFilterModel,
                after: copyFilterModel(nextFilterModel),
                viewChangeEpoch: confirmed.viewChangeEpoch
              }
            : undefined;
        return {
          kind: "planUpdated",
          action: "redo",
          revision: confirmed.revision,
          viewRequestId: request.viewRequestId,
          metadata: metadataFor(confirmed, result.page.page.totalRows),
          page: gridPageFromContract(result.page),
          code: result.code
        };
      }
      confirmed.draftStep = copyRTransformStep(retainedStep);
      confirmed.draftReplacesStepId = replaceStepId;
      confirmed.draftInputSchema = copySchema(inputSchema);
      confirmed.draftInputRSchema = inputRSchema;
      confirmed.draftInputRows = inputRows;
      confirmed.draftInputIdentityRows = inputIdentityRows;
      confirmed.draftInputKeyColumnIds = Object.freeze([...inputKeyColumnIds]);
      confirmed.draftInputRowNames = inputRowNames;
      confirmed.draftInputDataframeFlavor = inputDataframeFlavor;
      confirmed.draftInputCustomRowIdentities = inputCustomRowIdentities;
      confirmed.draftBaseFilterModel = draftBaseFilterModel;
      confirmed.draftBaseViewChangeEpoch = draftBaseViewChangeEpoch;
      const fallbackFillTargetId =
        step.kind === "fillMissingValues" && step.params.replacement.kind === "fallbackColumns"
          ? step.params.column.id
          : undefined;
      return {
        kind: "stepPreview",
        revision: confirmed.revision,
        metadata: metadataFor(confirmed, result.page.page.totalRows),
        page: gridPageFromContract(result.page),
        diff: copyDiff(result.diff),
        code: result.code,
        ...(result.remainingMissingCells === undefined ? {} : { remainingMissingCells: result.remainingMissingCells }),
        warnings:
          retainedStep.kind === "byExample"
            ? [...retainedStep.params.warnings]
            : fallbackFillTargetId !== undefined &&
                result.page.schema.find((column) => column.id === fallbackFillTargetId)?.nullable === true
              ? ["Some values are still missing because every selected fallback column is missing in those rows."]
              : []
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      confirmed.invalidated = true;
      throw error;
    }
  }

  async updatePlan(
    request: Extract<OpenWranglerRequest, { kind: "applyDraft" | "discardDraft" | "undoStep" }>,
    options: BridgeRequestOptions
  ): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    let currentView: ConfirmedView;
    try {
      currentView = confirmedMutationView(confirmed, options);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    let targetSchema: readonly ColumnSchema[];
    let targetRSchema: readonly RColumnSchema[];
    let targetRows: number;
    let targetIdentityRows: number;
    let targetKeyColumnIds: readonly string[];
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    let targetDataframeFlavor: RDataframeFlavor;
    let targetCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
    let nextFilterModel: FilterModel;
    if (request.kind === "applyDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds ||
        confirmed.draftInputRowNames === undefined ||
        confirmed.draftInputDataframeFlavor === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to apply.", true, request.sessionId);
      }
      if (confirmed.draftReplacesStepId !== undefined && confirmed.steps.at(-1)?.id !== confirmed.draftReplacesStepId) {
        return errorResponse(
          "invalid_request",
          "An earlier R step must be applied through the host plan-rewrite transaction.",
          true,
          request.sessionId
        );
      }
      targetSchema = confirmed.schema;
      targetRSchema = confirmed.rSchema;
      targetRows = confirmed.rows;
      targetIdentityRows = confirmed.identityRows;
      targetKeyColumnIds = confirmed.keyColumnIds;
      targetRowNames = confirmed.rowNames;
      targetDataframeFlavor = confirmed.dataframeFlavor;
      targetCustomRowIdentities = confirmed.customRowIdentities;
      nextFilterModel = copyFilterModel(currentView.filterModel);
    } else if (request.kind === "discardDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds ||
        confirmed.draftInputRowNames === undefined ||
        confirmed.draftInputDataframeFlavor === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to discard.", true, request.sessionId);
      }
      targetSchema = confirmed.committedSchema;
      targetRSchema = confirmed.committedRSchema;
      targetRows = confirmed.committedRows;
      targetIdentityRows = confirmed.committedIdentityRows;
      targetKeyColumnIds = confirmed.committedKeyColumnIds;
      targetRowNames = confirmed.committedRowNames;
      targetDataframeFlavor = confirmed.committedDataframeFlavor;
      targetCustomRowIdentities = confirmed.committedCustomRowIdentities;
      nextFilterModel =
        confirmed.draftBaseViewChangeEpoch === currentView.viewChangeEpoch && confirmed.draftBaseFilterModel
          ? copyFilterModel(confirmed.draftBaseFilterModel)
          : reconcileViewFilterModel(currentView.filterModel, confirmed.schema, targetSchema, "id");
    } else {
      if (confirmed.draftStep) {
        return errorResponse(
          "invalid_request",
          "Discard the R draft before undoing an applied step.",
          true,
          request.sessionId
        );
      }
      if (confirmed.steps.length === 0) {
        return errorResponse("invalid_request", "There is no applied R step to undo.", true, request.sessionId);
      }
      targetSchema = confirmed.planInputSchemas.at(-1) ?? confirmed.sourceSchema;
      targetRSchema = confirmed.planInputRSchemas.at(-1) ?? confirmed.sourceRSchema;
      targetRows = confirmed.planInputRows.at(-1) ?? confirmed.sourceRows;
      targetIdentityRows = confirmed.planInputIdentityRows.at(-1) ?? confirmed.sourceRows;
      targetKeyColumnIds = confirmed.planInputKeyColumnIds.at(-1) ?? confirmed.sourceKeyColumnIds;
      targetRowNames = confirmed.planInputRowNames.at(-1) ?? confirmed.sourceRowNames;
      targetDataframeFlavor = confirmed.planInputDataframeFlavors.at(-1) ?? confirmed.sourceDataframeFlavor;
      targetCustomRowIdentities = confirmed.planInputCustomRowIdentities.at(-1);
      const latest = confirmed.steps.at(-1) as RetainedTransformStep;
      const restore = confirmed.lastAppliedViewRestore;
      nextFilterModel =
        restore?.stepId === latest.id &&
        restore.viewChangeEpoch === currentView.viewChangeEpoch &&
        isDeepStrictEqual(restore.after, currentView.filterModel)
          ? copyFilterModel(restore.before)
          : reconcileViewFilterModel(currentView.filterModel, confirmed.schema, targetSchema, "id");
    }

    let view: RKernelViewQuery;
    try {
      view = resolveViewQuery(nextFilterModel, targetSchema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    confirmed.filterModel = currentView.filterModel;
    confirmed.viewChangeEpoch = currentView.viewChangeEpoch;
    const expectedRevision = confirmed.revision;
    const page = pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view);
    try {
      const result = await (request.kind === "applyDraft"
        ? this.transport.applyDraft(request.sessionId, expectedRevision, page, transportOptions(options))
        : request.kind === "discardDraft"
          ? this.transport.discardDraft(request.sessionId, expectedRevision, page, transportOptions(options))
          : this.transport.undoStep(request.sessionId, expectedRevision, page, transportOptions(options)));
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      const expectedAction =
        request.kind === "applyDraft" ? "apply" : request.kind === "discardDraft" ? "discard" : "undo";
      if (
        result.sessionId !== request.sessionId ||
        result.revision !== expectedRevision + 1 ||
        result.action !== expectedAction
      ) {
        throw new Error("The R kernel returned a mismatched cleaning-plan update.");
      }
      if (confirmed.revision !== expectedRevision) {
        confirmed.invalidated = true;
        return staleResponseError(request.sessionId);
      }
      assertMutationContract(
        confirmed,
        result.page,
        request,
        targetSchema,
        targetRows,
        targetIdentityRows,
        targetKeyColumnIds,
        targetRowNames,
        view,
        undefined,
        targetDataframeFlavor
      );
      assertCustomDerivedRowIdentities(result.page, targetCustomRowIdentities, view);
      if (!isDeepStrictEqual(targetRSchema, result.page.schema)) {
        throw new Error("The R kernel returned a cleaning-plan update for the wrong R schema.");
      }

      const priorRestore = confirmed.lastAppliedViewRestore;
      if (request.kind === "applyDraft") {
        confirmed.redoSteps = [];
        const draftStep = confirmed.draftStep as RTransformStep;
        const draftInputSchema = confirmed.draftInputSchema as readonly ColumnSchema[];
        const draftInputRSchema = confirmed.draftInputRSchema as readonly RColumnSchema[];
        const draftInputRows = confirmed.draftInputRows as number;
        const draftInputIdentityRows = confirmed.draftInputIdentityRows as number;
        const draftInputKeyColumnIds = confirmed.draftInputKeyColumnIds as readonly string[];
        const draftInputRowNames = confirmed.draftInputRowNames as RFramePageContract["frameSemantics"]["rowNames"];
        const draftInputDataframeFlavor = confirmed.draftInputDataframeFlavor as RDataframeFlavor;
        const draftInputCustomRowIdentities = confirmed.draftInputCustomRowIdentities;
        if (confirmed.draftReplacesStepId === undefined) {
          confirmed.steps = [...confirmed.steps, copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas, copySchema(draftInputSchema)];
          confirmed.planInputRSchemas = [...confirmed.planInputRSchemas, draftInputRSchema];
          confirmed.planInputRows = [...confirmed.planInputRows, draftInputRows];
          confirmed.planInputIdentityRows = [...confirmed.planInputIdentityRows, draftInputIdentityRows];
          confirmed.planInputKeyColumnIds = [
            ...confirmed.planInputKeyColumnIds,
            Object.freeze([...draftInputKeyColumnIds])
          ];
          confirmed.planInputRowNames = [...confirmed.planInputRowNames, draftInputRowNames];
          confirmed.planInputDataframeFlavors = [...confirmed.planInputDataframeFlavors, draftInputDataframeFlavor];
          confirmed.planInputCustomRowIdentities = [
            ...confirmed.planInputCustomRowIdentities,
            draftInputCustomRowIdentities
          ];
        } else {
          confirmed.steps = [...confirmed.steps.slice(0, -1), copyRTransformStep(draftStep)];
          confirmed.planInputSchemas = [...confirmed.planInputSchemas.slice(0, -1), copySchema(draftInputSchema)];
          confirmed.planInputRSchemas = [...confirmed.planInputRSchemas.slice(0, -1), draftInputRSchema];
          confirmed.planInputRows = [...confirmed.planInputRows.slice(0, -1), draftInputRows];
          confirmed.planInputIdentityRows = [...confirmed.planInputIdentityRows.slice(0, -1), draftInputIdentityRows];
          confirmed.planInputKeyColumnIds = [
            ...confirmed.planInputKeyColumnIds.slice(0, -1),
            Object.freeze([...draftInputKeyColumnIds])
          ];
          confirmed.planInputRowNames = [...confirmed.planInputRowNames.slice(0, -1), draftInputRowNames];
          confirmed.planInputDataframeFlavors = [
            ...confirmed.planInputDataframeFlavors.slice(0, -1),
            draftInputDataframeFlavor
          ];
          confirmed.planInputCustomRowIdentities = [
            ...confirmed.planInputCustomRowIdentities.slice(0, -1),
            draftInputCustomRowIdentities
          ];
        }
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.committedRowNames = targetRowNames;
        confirmed.committedDataframeFlavor = targetDataframeFlavor;
        confirmed.committedCustomRowIdentities = targetCustomRowIdentities;
        const chainedRestore =
          confirmed.draftReplacesStepId === draftStep.id &&
          priorRestore?.stepId === draftStep.id &&
          priorRestore.viewChangeEpoch === confirmed.viewChangeEpoch &&
          isDeepStrictEqual(priorRestore.after, confirmed.draftBaseFilterModel)
            ? priorRestore
            : undefined;
        const replacementLostOriginalView =
          confirmed.draftReplacesStepId === draftStep.id && chainedRestore === undefined;
        if (
          confirmed.draftBaseViewChangeEpoch === confirmed.viewChangeEpoch &&
          confirmed.draftBaseFilterModel &&
          !replacementLostOriginalView
        ) {
          confirmed.lastAppliedViewRestore = {
            stepId: draftStep.id,
            before: copyFilterModel(chainedRestore?.before ?? confirmed.draftBaseFilterModel),
            after: copyFilterModel(nextFilterModel),
            viewChangeEpoch: confirmed.viewChangeEpoch
          };
        } else {
          confirmed.lastAppliedViewRestore = undefined;
        }
      } else if (request.kind === "undoStep") {
        confirmed.redoSteps = [...confirmed.redoSteps, copyRTransformStep(confirmed.steps.at(-1) as RTransformStep)];
        confirmed.steps = confirmed.steps.slice(0, -1);
        confirmed.planInputSchemas = confirmed.planInputSchemas.slice(0, -1);
        confirmed.planInputRSchemas = confirmed.planInputRSchemas.slice(0, -1);
        confirmed.planInputRows = confirmed.planInputRows.slice(0, -1);
        confirmed.planInputIdentityRows = confirmed.planInputIdentityRows.slice(0, -1);
        confirmed.planInputKeyColumnIds = confirmed.planInputKeyColumnIds.slice(0, -1);
        confirmed.planInputRowNames = confirmed.planInputRowNames.slice(0, -1);
        confirmed.planInputDataframeFlavors = confirmed.planInputDataframeFlavors.slice(0, -1);
        confirmed.planInputCustomRowIdentities = confirmed.planInputCustomRowIdentities.slice(0, -1);
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.committedRowNames = targetRowNames;
        confirmed.committedDataframeFlavor = targetDataframeFlavor;
        confirmed.committedCustomRowIdentities = targetCustomRowIdentities;
        confirmed.lastAppliedViewRestore = undefined;
      }

      confirmed.revision = result.revision;
      confirmed.schema = schemaFromContract(result.page);
      confirmed.rSchema = result.page.schema;
      confirmed.rows = targetRows;
      confirmed.identityRows = targetIdentityRows;
      confirmed.keyColumnIds = Object.freeze([...targetKeyColumnIds]);
      confirmed.rowNames = targetRowNames;
      confirmed.dataframeFlavor = targetDataframeFlavor;
      confirmed.customRowIdentities = targetCustomRowIdentities;
      confirmed.filterModel = nextFilterModel;
      clearDraft(confirmed);
      return {
        kind: "planUpdated",
        action: result.action,
        revision: confirmed.revision,
        metadata: metadataFor(confirmed, result.page.page.totalRows),
        page: gridPageFromContract(result.page),
        code: result.code
      };
    } catch (error) {
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (error instanceof RKernelDiagnosticError) return diagnosticResponse(error, request.sessionId);
      confirmed.invalidated = true;
      throw error;
    }
  }
}

function confirmedMutationView(session: RBridgeSession, options: BridgeRequestOptions): ConfirmedView {
  const view = options.confirmedView;
  if (view !== undefined) {
    if (!isConfirmedView(view)) throw new Error("The confirmed R view is malformed.");
    resolveViewQuery(view.filterModel, session.schema);
  }
  return {
    filterModel: copyFilterModel(view?.filterModel ?? session.filterModel),
    viewChangeEpoch: view?.viewChangeEpoch ?? session.viewChangeEpoch
  };
}
