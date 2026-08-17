import { isDeepStrictEqual } from "node:util";
import {
  type ColumnSchema,
  type FilterModel,
  type OpenWranglerRequest,
  type OpenWranglerResponse,
  type PreviewStepRequest,
  type RetainedTransformStep
} from "../../shared/protocol";
import type { BridgeRequestOptions } from "../dataBridge";
import { RKernelDiagnosticError } from "./rKernelTransport";
import type { RKernelBridgeTransport } from "./rKernelBridgeTransport";
import { type RKernelTransformStep, type RKernelViewQuery } from "./rKernelProtocol";
import type { RColumnSchema, RFramePageContract } from "./rFrameContract";
import {
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
import { reconcileFilterModelById } from "./rKernelColumnSchema";
import { rTransformStep, type RTransformStep } from "./rKernelTransformBinding";
import {
  assertMutationDiff,
  categoricalRetainedSchema,
  copyDiff,
  isRCategoricalTransformStep
} from "./rKernelMutationDiff";
import {
  acceptRetainedByExampleStep,
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
  type RCustomRowIdentityConstraint
} from "./rKernelMutationSchema";
import { copyRTransformStep } from "./rKernelTransformState";
import { resolveRViewQuery as resolveViewQuery } from "./rKernelViewContract";

/**
 * Owns native-R preview and cleaning-plan mutations against confirmed bridge
 * sessions while preserving the bridge's exact transport correlation rules.
 */
export class RKernelMutationLifecycle {
  constructor(
    private readonly transport: RKernelBridgeTransport,
    private readonly sessions: Map<string, RBridgeSession>
  ) {}

  async previewStep(request: PreviewStepRequest, options: BridgeRequestOptions): Promise<OpenWranglerResponse> {
    const session = this.sessions.get(request.sessionId);
    const invalid = validateMutationRequest(session, request.revision, request);
    if (invalid) return invalid;
    const confirmed = session as RBridgeSession;
    if (confirmed.draftStep) {
      return errorResponse(
        "invalid_request",
        "Apply or discard the current R draft before previewing another step.",
        true,
        request.sessionId
      );
    }
    const requestedStepKind: string = request.step.kind;
    if (
      request.step.kind !== "sortRows" &&
      request.step.kind !== "filterRows" &&
      request.step.kind !== "dropMissingRows" &&
      request.step.kind !== "fillMissingValues" &&
      request.step.kind !== "dropDuplicates" &&
      request.step.kind !== "renameColumn" &&
      request.step.kind !== "cloneColumn" &&
      request.step.kind !== "castColumn" &&
      request.step.kind !== "formula" &&
      request.step.kind !== "textLength" &&
      request.step.kind !== "oneHotEncode" &&
      request.step.kind !== "multiLabelBinarize" &&
      request.step.kind !== "findReplace" &&
      request.step.kind !== "stripText" &&
      request.step.kind !== "splitText" &&
      request.step.kind !== "capitalizeText" &&
      request.step.kind !== "lowerText" &&
      request.step.kind !== "upperText" &&
      request.step.kind !== "minMaxScale" &&
      request.step.kind !== "roundNumber" &&
      request.step.kind !== "floorNumber" &&
      request.step.kind !== "ceilNumber" &&
      request.step.kind !== "formatDatetime" &&
      request.step.kind !== "groupBy" &&
      request.step.kind !== "byExample" &&
      request.step.kind !== "customCode" &&
      request.step.kind !== "dropColumns" &&
      request.step.kind !== "selectColumns"
    ) {
      return errorResponse(
        "unsupported_operation",
        `The native R runtime does not support ${requestedStepKind}.`,
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
    let inputCustomRowIdentities: RCustomRowIdentityConstraint | undefined;
    if (request.replaceStepId !== undefined) {
      const latest = confirmed.steps.at(-1);
      if (!latest || latest.id !== request.replaceStepId || request.step.id !== request.replaceStepId) {
        return errorResponse(
          "invalid_request",
          "Only the latest applied R step can be edited, and it must retain its step ID.",
          true,
          request.sessionId
        );
      }
      inputSchema = confirmed.planInputSchemas.at(-1) ?? confirmed.committedSchema;
      inputRSchema = confirmed.planInputRSchemas.at(-1) ?? confirmed.committedRSchema;
      inputRows = confirmed.planInputRows.at(-1) ?? confirmed.committedRows;
      inputIdentityRows = confirmed.planInputIdentityRows.at(-1) ?? confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.planInputKeyColumnIds.at(-1) ?? confirmed.committedKeyColumnIds;
      inputRowNames = confirmed.planInputRowNames.at(-1) ?? confirmed.sourceRowNames;
      inputCustomRowIdentities = confirmed.planInputCustomRowIdentities.at(-1);
    } else {
      if (confirmed.steps.some((step) => step.id === request.step.id)) {
        return errorResponse("invalid_request", "Applied R step IDs must be unique.", true, request.sessionId);
      }
      inputSchema = confirmed.committedSchema;
      inputRSchema = confirmed.committedRSchema;
      inputRows = confirmed.committedRows;
      inputIdentityRows = confirmed.committedIdentityRows;
      inputKeyColumnIds = confirmed.committedKeyColumnIds;
      inputRowNames = confirmed.committedRowNames;
      inputCustomRowIdentities = confirmed.committedCustomRowIdentities;
    }

    let targetSchema: readonly ColumnSchema[];
    let targetKeyColumnIds: readonly string[];
    let nextFilterModel: FilterModel;
    let view: RKernelViewQuery;
    let rStep: RKernelTransformStep;
    let retainedStep: RTransformStep;
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
    try {
      targetSchema =
        request.step.kind === "byExample" || request.step.kind === "customCode"
          ? Object.freeze(inputSchema.map((column) => Object.freeze({ ...column })))
          : isRCategoricalTransformStep(request.step)
            ? categoricalRetainedSchema(inputSchema, request.step)
            : schemaAfterRStep(inputSchema, request.step, inputKeyColumnIds);
      targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, request.step);
      rStep = rTransformStep(request.step, inputSchema);
      targetRowNames = rowNamesAfterRStep(inputRowNames, request.step);
      nextFilterModel =
        request.step.kind === "customCode"
          ? copyFilterModel(confirmed.filterModel)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
      view = resolveViewQuery(nextFilterModel, request.step.kind === "customCode" ? confirmed.schema : targetSchema);
      validatePageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit);
    } catch (error) {
      return errorResponse(
        "invalid_request",
        error instanceof Error ? error.message : String(error),
        true,
        request.sessionId
      );
    }

    const expectedRevision = confirmed.revision;
    const expectedSchema = confirmed.schema;
    const draftBaseFilterModel = copyFilterModel(confirmed.filterModel);
    const draftBaseViewChangeEpoch = confirmed.viewChangeEpoch;
    try {
      const result = await this.transport.previewStep(
        request.sessionId,
        expectedRevision,
        rStep,
        pageWindow(request.offset, request.limit, request.columnOffset, request.columnLimit, view),
        inputRSchema,
        request.replaceStepId,
        transportOptions(options)
      );
      if (confirmed.invalidated) return kernelChangedError(request.sessionId);
      if (result.sessionId !== request.sessionId || result.revision !== expectedRevision + 1) {
        throw new Error("The R kernel returned a mismatched step preview.");
      }
      if (confirmed.revision !== expectedRevision || confirmed.schema !== expectedSchema) {
        confirmed.invalidated = true;
        return staleResponseError(request.sessionId);
      }
      if ((request.step.kind === "customCode") !== (result.effectiveView !== undefined)) {
        throw new Error("The R kernel returned an effective view for the wrong draft operation.");
      }
      if (isRCategoricalTransformStep(request.step)) {
        targetSchema = dynamicCategoricalSchema(inputSchema, inputRSchema, request.step, result.page);
        targetKeyColumnIds = keyColumnsAfterRStep(inputKeyColumnIds, targetSchema, request.step);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, view)) {
          throw new Error("The R categorical schema changed the pre-dispatch viewing query.");
        }
      }
      if (request.step.kind === "customCode") {
        const effectiveView = result.effectiveView;
        if (effectiveView === undefined) {
          throw new Error("The R custom-code preview omitted its effective view.");
        }
        if (result.retainedStep !== undefined) {
          throw new Error("The R kernel returned a retained step for the wrong draft operation.");
        }
        retainedStep = copyRTransformStep(request.step);
        targetSchema = dynamicCustomCodeSchema(inputSchema, request.step, result.page);
        targetKeyColumnIds = Object.freeze([...result.page.frameSemantics.keyColumnIds]);
        targetRowNames = result.page.frameSemantics.rowNames;
        nextFilterModel = reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
        const resolvedView = resolveViewQuery(nextFilterModel, targetSchema);
        if (!isDeepStrictEqual(resolvedView, effectiveView)) {
          throw new Error("The R custom-code preview returned a mismatched effective view.");
        }
        view = effectiveView;
      } else if (request.step.kind === "byExample") {
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
        retainedStep = copyRTransformStep(request.step);
      }
      const targetRows = rowCountAfterRStep(request.step, inputRows, result.diff);
      const targetIdentityRows = rowIdentityDomainAfterRStep(request.step, inputIdentityRows, targetRows);
      const targetCustomRowIdentities = customRowIdentityConstraintAfterRStep(
        request.step,
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
        request.step.kind === "castColumn"
          ? { columnId: request.step.params.column.id, mode: "mayAdd" }
          : request.step.kind === "minMaxScale"
            ? {
                columnId:
                  request.step.params.newColumn === undefined ||
                  request.step.params.newColumn === request.step.params.column.name
                    ? request.step.params.column.id
                    : `c:step:${request.step.id}:0`,
                mode: "mayAdd"
              }
            : request.step.kind === "splitText"
              ? { columnId: `c:step:${request.step.id}:0`, mode: "mayAdd" }
              : request.step.kind === "fillMissingValues" && request.step.params.replacement.kind === "fallbackColumns"
                ? { columnId: request.step.params.column.id, mode: "mayRemove" }
                : undefined
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
      if ((request.step.kind === "fillMissingValues") !== (result.remainingMissingCells !== undefined)) {
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
      confirmed.filterModel = nextFilterModel;
      confirmed.draftStep = copyRTransformStep(retainedStep);
      confirmed.draftReplacesStepId = request.replaceStepId;
      confirmed.draftInputSchema = copySchema(inputSchema);
      confirmed.draftInputRSchema = inputRSchema;
      confirmed.draftInputRows = inputRows;
      confirmed.draftInputIdentityRows = inputIdentityRows;
      confirmed.draftInputKeyColumnIds = Object.freeze([...inputKeyColumnIds]);
      confirmed.draftInputRowNames = inputRowNames;
      confirmed.draftInputCustomRowIdentities = inputCustomRowIdentities;
      confirmed.draftBaseFilterModel = draftBaseFilterModel;
      confirmed.draftBaseViewChangeEpoch = draftBaseViewChangeEpoch;
      const fallbackFillTargetId =
        request.step.kind === "fillMissingValues" && request.step.params.replacement.kind === "fallbackColumns"
          ? request.step.params.column.id
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

    let targetSchema: readonly ColumnSchema[];
    let targetRSchema: readonly RColumnSchema[];
    let targetRows: number;
    let targetIdentityRows: number;
    let targetKeyColumnIds: readonly string[];
    let targetRowNames: RFramePageContract["frameSemantics"]["rowNames"];
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
        confirmed.draftInputRowNames === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to apply.", true, request.sessionId);
      }
      targetSchema = confirmed.schema;
      targetRSchema = confirmed.rSchema;
      targetRows = confirmed.rows;
      targetIdentityRows = confirmed.identityRows;
      targetKeyColumnIds = confirmed.keyColumnIds;
      targetRowNames = confirmed.rowNames;
      targetCustomRowIdentities = confirmed.customRowIdentities;
      nextFilterModel = copyFilterModel(confirmed.filterModel);
    } else if (request.kind === "discardDraft") {
      if (
        !confirmed.draftStep ||
        !confirmed.draftInputSchema ||
        !confirmed.draftInputRSchema ||
        confirmed.draftInputRows === undefined ||
        confirmed.draftInputIdentityRows === undefined ||
        !confirmed.draftInputKeyColumnIds ||
        confirmed.draftInputRowNames === undefined
      ) {
        return errorResponse("invalid_request", "There is no R draft step to discard.", true, request.sessionId);
      }
      targetSchema = confirmed.committedSchema;
      targetRSchema = confirmed.committedRSchema;
      targetRows = confirmed.committedRows;
      targetIdentityRows = confirmed.committedIdentityRows;
      targetKeyColumnIds = confirmed.committedKeyColumnIds;
      targetRowNames = confirmed.committedRowNames;
      targetCustomRowIdentities = confirmed.committedCustomRowIdentities;
      nextFilterModel =
        confirmed.draftBaseViewChangeEpoch === confirmed.viewChangeEpoch && confirmed.draftBaseFilterModel
          ? copyFilterModel(confirmed.draftBaseFilterModel)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
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
      targetCustomRowIdentities = confirmed.planInputCustomRowIdentities.at(-1);
      const latest = confirmed.steps.at(-1) as RetainedTransformStep;
      const restore = confirmed.lastAppliedViewRestore;
      nextFilterModel =
        restore?.stepId === latest.id &&
        restore.viewChangeEpoch === confirmed.viewChangeEpoch &&
        isDeepStrictEqual(restore.after, confirmed.filterModel)
          ? copyFilterModel(restore.before)
          : reconcileFilterModelById(confirmed.filterModel, confirmed.schema, targetSchema);
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
        view
      );
      assertCustomDerivedRowIdentities(result.page, targetCustomRowIdentities, view);
      if (!isDeepStrictEqual(targetRSchema, result.page.schema)) {
        throw new Error("The R kernel returned a cleaning-plan update for the wrong R schema.");
      }

      const priorRestore = confirmed.lastAppliedViewRestore;
      if (request.kind === "applyDraft") {
        const draftStep = confirmed.draftStep as RTransformStep;
        const draftInputSchema = confirmed.draftInputSchema as readonly ColumnSchema[];
        const draftInputRSchema = confirmed.draftInputRSchema as readonly RColumnSchema[];
        const draftInputRows = confirmed.draftInputRows as number;
        const draftInputIdentityRows = confirmed.draftInputIdentityRows as number;
        const draftInputKeyColumnIds = confirmed.draftInputKeyColumnIds as readonly string[];
        const draftInputRowNames = confirmed.draftInputRowNames as RFramePageContract["frameSemantics"]["rowNames"];
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
        confirmed.steps = confirmed.steps.slice(0, -1);
        confirmed.planInputSchemas = confirmed.planInputSchemas.slice(0, -1);
        confirmed.planInputRSchemas = confirmed.planInputRSchemas.slice(0, -1);
        confirmed.planInputRows = confirmed.planInputRows.slice(0, -1);
        confirmed.planInputIdentityRows = confirmed.planInputIdentityRows.slice(0, -1);
        confirmed.planInputKeyColumnIds = confirmed.planInputKeyColumnIds.slice(0, -1);
        confirmed.planInputRowNames = confirmed.planInputRowNames.slice(0, -1);
        confirmed.planInputCustomRowIdentities = confirmed.planInputCustomRowIdentities.slice(0, -1);
        confirmed.committedSchema = schemaFromContract(result.page);
        confirmed.committedRSchema = result.page.schema;
        confirmed.committedRows = targetRows;
        confirmed.committedIdentityRows = targetIdentityRows;
        confirmed.committedKeyColumnIds = Object.freeze([...targetKeyColumnIds]);
        confirmed.committedRowNames = targetRowNames;
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
