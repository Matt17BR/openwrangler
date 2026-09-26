import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as vscode from "vscode";
import type {
  ColumnSchema,
  DataBackend,
  OpenSessionRequest,
  OpenWranglerResponse,
  PageResponse,
  RLibrary,
  SessionBoundRequest,
  SessionOpenedResponse,
  SessionSource,
  TransformStep
} from "../shared/protocol";
import { isFileDataBackend } from "./pythonEnvironmentModel";
import { supportsOperation } from "../shared/operations";
import { translatePlanColumns } from "../shared/transformStepReferences";
import { canRequestLiveSessionMode } from "../shared/sessionMode";
import {
  DetachedBridgeRequestError,
  type BridgeRequestOptions,
  type CancellationTokenLike,
  type FilePlanColumnMappingChooser,
  type OpenWranglerBridge
} from "./dataBridge";
import type { CoordinatedSessionOrigin } from "./sessionOrigin";
import { captureSessionSourceFiles, sessionOriginMismatch } from "./sessionOrigin";
import { confirmSessionSourceProtection, type SessionSourceProtection } from "./files/safeFileExport";
import { SessionPersistenceStore } from "./sessionPersistenceStore";
import { persistedSessionState } from "./sessionPersistence";
import { sessionOpenedResponseMismatch } from "./sessionResponseValidation";
import { protocolError, type SessionResponseState } from "./sessionResponseCommitter";
import { SessionRequestScheduler } from "./sessionRequestScheduler";
import { SessionRuntimeCleanup } from "./sessionRuntimeCleanup";
import {
  discardRuntimeRecoveryCandidate,
  runtimeRecoveryDelegateFactory,
  type RuntimeRecoveryDelegateCandidate
} from "./sessionRuntimeRecovery";
import { confirmedReplayOpenRequest, publicOpenedResponse } from "./sessionRuntimeReconfigurer";
import {
  initialViewingState,
  RuntimeStateRestoreError,
  SessionRuntimeStateRestorer
} from "./sessionRuntimeStateRestorer";

export interface RuntimeEstablishedSession extends SessionResponseState {
  backendPreference?: DataBackend;
  origin?: CoordinatedSessionOrigin;
  scheduler: SessionRequestScheduler;
  closing: boolean;
  reconfiguring: boolean;
  reconnecting: boolean;
  liveReconnectRequired: boolean;
  recoveryRequired: boolean;
  /** Host-detached runtime work that must settle before this session may issue more work. */
  runtimeSettlementBarrier?: Promise<void>;
  /** A copied plan shown read-only; nothing is saved for its target until the user keeps it. */
  copiedPlanPending?: boolean;
}

export type RuntimeEstablishmentResult =
  | { established: false; response: OpenWranglerResponse }
  | { established: true; response: SessionOpenedResponse; session: RuntimeEstablishedSession };

export interface RuntimeEstablishmentHooks {
  isCoordinatorAvailable(): boolean;
  copyTargetFailure?(metadata?: SessionOpenedResponse["metadata"]): OpenWranglerResponse | undefined;
  executeSessionRequest(
    session: RuntimeEstablishedSession,
    request: SessionBoundRequest,
    options?: BridgeRequestOptions
  ): Promise<OpenWranglerResponse>;
}

/** A host-owned plan captured before the user chooses another file. */
export interface InitialFilePlan {
  readonly backend: Extract<DataBackend, "pandas" | "polars" | "duckdb" | "r">;
  readonly rLibrary?: RLibrary;
  readonly importOptions: SessionSource["importOptions"];
  readonly sourceSchema: readonly ColumnSchema[];
  readonly steps: readonly TransformStep[];
  /** Asks the user to match original columns that have no same-name, same-type column in the target. */
  readonly chooseColumnMapping: FilePlanColumnMappingChooser;
  isCurrent(): boolean;
  assertTargetAvailable(source: SessionSource, protection: SessionSourceProtection): Promise<void>;
}

export interface InitialRLibraryCopy {
  readonly kind: "rLibraryCopy";
  readonly backend: "r";
  readonly rLibrary: RLibrary;
  readonly source: SessionSource;
  readonly cloneFrom: NonNullable<OpenSessionRequest["cloneFrom"]>;
  readonly steps: readonly TransformStep[];
  isCurrent(): boolean;
  assertTargetAvailable(source: SessionSource, protection: SessionSourceProtection): Promise<void>;
}

export type InitialSessionPlan = InitialFilePlan | InitialRLibraryCopy;

export function isRLibraryCopy(plan: InitialSessionPlan | undefined): plan is InitialRLibraryCopy {
  return plan !== undefined && "kind" in plan && plan.kind === "rLibraryCopy";
}

/** The user declined to match the copied plan's columns. */
class FilePlanMappingDeclined extends Error {}

function sameColumnType(left: ColumnSchema, right: ColumnSchema): boolean {
  return left.type === right.type && left.rawType === right.rawType;
}

function quotedColumnList(columns: readonly ColumnSchema[]): string {
  return columns.map((column) => `“${column.name}”`).join(", ");
}

async function initialFilePlanSteps(
  plan: InitialFilePlan,
  schema: readonly ColumnSchema[],
  assertCurrent: () => void,
  cancellation: CancellationTokenLike | undefined
): Promise<TransformStep[]> {
  if (
    schema.length === plan.sourceSchema.length &&
    schema.every((column, index) => {
      const original = plan.sourceSchema[index];
      return (
        column.id === original.id &&
        column.name === original.name &&
        column.position === original.position &&
        sameColumnType(column, original)
      );
    })
  )
    return structuredClone([...plan.steps]);

  const byName = new Map(schema.map((column) => [column.name, column]));
  if (byName.size !== schema.length || byName.has(""))
    throw new RuntimeStateRestoreError(
      "The selected file has duplicate or empty column names, so its columns cannot be matched to the plan."
    );
  if (schema.length !== plan.sourceSchema.length)
    throw new RuntimeStateRestoreError(
      `The selected file has ${schema.length} columns, but the plan's original input has ${plan.sourceSchema.length}.`
    );

  const targets = new Map<string, ColumnSchema>();
  for (const original of plan.sourceSchema) {
    const target = byName.get(original.name);
    if (target && sameColumnType(target, original)) targets.set(original.id, target);
  }
  const unmatched = plan.sourceSchema.filter((original) => !targets.has(original.id));
  if (unmatched.length > 0) {
    const matched = new Set([...targets.values()].map((column) => column.id));
    const candidates = schema.filter((column) => !matched.has(column.id));
    // Type equality partitions both sides, so equal per-type counts guarantee that any sequence of choices completes.
    const incompatible = unmatched.filter(
      (original) =>
        unmatched.filter((other) => sameColumnType(other, original)).length >
        candidates.filter((column) => sameColumnType(column, original)).length
    );
    if (incompatible.length > 0)
      throw new RuntimeStateRestoreError(
        `The selected file has no remaining column with the same type as ${quotedColumnList(incompatible)}.`
      );
    const chosen = await plan.chooseColumnMapping(
      { unmatched: structuredClone(unmatched), candidates: structuredClone(candidates) },
      cancellation
    );
    assertCurrent();
    if (!chosen) throw new FilePlanMappingDeclined();
    const used = new Set<string>();
    for (const original of unmatched) {
      const target = candidates.find((column) => column.id === chosen.get(original.id));
      if (!target || used.has(target.id) || !sameColumnType(target, original))
        throw new RuntimeStateRestoreError("The chosen columns do not match the plan's original input.");
      used.add(target.id);
      targets.set(original.id, target);
    }
    if (chosen.size !== unmatched.length)
      throw new RuntimeStateRestoreError("The chosen columns do not match the plan's original input.");
  }

  const translated = translatePlanColumns(plan.steps, plan.sourceSchema, targets);
  if (typeof translated === "string") throw new RuntimeStateRestoreError(translated);
  return translated;
}

export class SessionRuntimeEstablisher {
  constructor(
    private readonly runtimeCleanup: SessionRuntimeCleanup,
    private readonly runtimeStateRestorer: SessionRuntimeStateRestorer,
    private readonly persistence: SessionPersistenceStore
  ) {}

  async establish(
    delegate: OpenWranglerBridge,
    request: OpenSessionRequest,
    options: BridgeRequestOptions | undefined,
    origin: CoordinatedSessionOrigin | undefined,
    hooks: RuntimeEstablishmentHooks,
    sourceProtection?: SessionSourceProtection,
    initialPlan?: InitialSessionPlan
  ): Promise<RuntimeEstablishmentResult> {
    const invalidOrigin = sessionOriginMismatch(request, origin);
    if (invalidOrigin) {
      return { established: false, response: protocolError("invalid_source_origin", invalidOrigin, true) };
    }
    sourceProtection ??= await captureSessionSourceFiles(request.source);
    let targetRuntimeIsCurrent: (() => boolean) | undefined;
    let openedMetadata: SessionOpenedResponse["metadata"] | undefined = undefined;
    const currentFailure = (): OpenWranglerResponse | undefined => {
      const copyTargetFailure = hooks.copyTargetFailure?.(openedMetadata);
      if (copyTargetFailure) return copyTargetFailure;
      if (!hooks.isCoordinatorAvailable())
        return protocolError(
          "coordinator_disposed",
          "The Open Wrangler session coordinator was disposed before the dataframe finished opening.",
          false
        );
      if (options?.cancellation?.isCancellationRequested) return { kind: "cancelled", targetRequestId: "not-started" };
      if (initialPlan && (!vscode.workspace.isTrusted || !initialPlan.isCurrent()))
        return protocolError(
          "file_plan_changed",
          isRLibraryCopy(initialPlan)
            ? "The original R session changed or is no longer available. Open the library picker again."
            : "The session that supplied this plan changed or is no longer available. Run Open Another File with This Plan again.",
          true
        );
      const mismatch = sessionOriginMismatch(request, origin);
      if (targetRuntimeIsCurrent && !targetRuntimeIsCurrent())
        return protocolError(
          "file_plan_target_runtime_changed",
          "The runtime opening this file changed or stopped. Reopen the target to inspect any saved plan.",
          true
        );
      return mismatch ? protocolError("invalid_source_origin", mismatch, true) : undefined;
    };
    const beforeOpen = currentFailure();
    if (beforeOpen) return { established: false, response: beforeOpen };
    if (options?.requiredSourceProtection) {
      sourceProtection = await confirmSessionSourceProtection(sourceProtection);
      const afterSourceCheck = currentFailure();
      if (afterSourceCheck) return { established: false, response: afterSourceCheck };
      if (!sourceProtection.available)
        return {
          established: false,
          response: protocolError("source_changed", "The selected file changed. Choose the file again.", true)
        };
    }
    if (initialPlan) {
      if (
        request.backend !== initialPlan.backend ||
        request.mode !== "editing" ||
        (request.backend === "r" && (request.rLibrary ?? "base") !== (initialPlan.rLibrary ?? "base")) ||
        (isRLibraryCopy(initialPlan)
          ? !isDeepStrictEqual(request.source, initialPlan.source) ||
            !isDeepStrictEqual(request.cloneFrom, initialPlan.cloneFrom)
          : request.source.kind !== "file" ||
            !isDeepStrictEqual(request.source.importOptions, initialPlan.importOptions))
      )
        return {
          established: false,
          response: protocolError(
            "invalid_file_plan_target",
            "Plan reuse requires the original engine and import options.",
            true
          )
        };
      const absent =
        request.source.kind === "file"
          ? this.persistence.checkAbsent(request.source, initialPlan.backend, initialPlan.rLibrary)
          : { kind: "absent" as const };
      if (absent.kind !== "absent")
        return {
          established: false,
          response: protocolError(
            absent.kind === "occupied" ? "file_plan_target_occupied" : "persistence_unavailable",
            absent.kind === "occupied"
              ? "This file already has saved Open Wrangler work for this engine, R library and import options. For an R library, choose Open file separately in the library picker."
              : "Open Wrangler could not read workspace storage. Retry after storage is available.",
            true
          )
        };
      try {
        await initialPlan.assertTargetAvailable(request.source, sourceProtection);
      } catch {
        return {
          established: false,
          response: protocolError(
            "file_plan_target_unavailable",
            isRLibraryCopy(initialPlan)
              ? "An editor already owns this source with the selected R library. Use that editor instead."
              : "Choose a different file from every open file session. Open Wrangler must be able to verify those file identities.",
            true
          )
        };
      }
      const afterPreflight = currentFailure();
      if (afterPreflight) return { established: false, response: afterPreflight };
    }
    const response = await delegate.request(request, options);
    if (response.kind === "error" || response.kind === "cancelled") {
      return { established: false, response };
    }
    if (response.kind !== "sessionOpened") {
      return {
        established: false,
        response: protocolError(
          "invalid_runtime_response",
          `The runtime returned ${response.kind} while opening an Open Wrangler session.`,
          true
        )
      };
    }
    openedMetadata = response.metadata;

    const publicId = randomUUID();
    const backendPreference =
      options?.backendPreference === "auto" ? undefined : (options?.backendPreference ?? request.backend);
    const sessionOwner: { current?: RuntimeEstablishedSession } = {};
    const scheduler = new SessionRequestScheduler((scheduledRequest, scheduledOptions) => {
      const current = sessionOwner.current;
      if (!current) throw new Error("The session scheduler started before its session was initialized.");
      return hooks.executeSessionRequest(current, scheduledRequest, scheduledOptions);
    });
    const session: RuntimeEstablishedSession = {
      sourceProtection,
      publicId,
      runtimeId: response.metadata.sessionId,
      publicRevision: response.metadata.revision,
      runtimeRevision: response.metadata.revision,
      openRequest: confirmedReplayOpenRequest(request, response.metadata),
      ...(backendPreference ? { backendPreference } : {}),
      ...(origin ? { origin } : {}),
      delegate,
      scheduler,
      metadata: response.metadata,
      code: "",
      viewState: initialViewingState(response.metadata),
      viewChangeEpoch: 0,
      closing: false,
      reconfiguring: false,
      reconnecting: false,
      liveReconnectRequired: false,
      recoveryRequired: false
    };
    sessionOwner.current = session;
    const afterOpen = currentFailure();
    if (afterOpen) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return { established: false, response: afterOpen };
    }
    const openedMismatch = sessionOpenedResponseMismatch(request, response, initialPlan !== undefined);
    if (openedMismatch) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      return {
        established: false,
        response: protocolError(
          "invalid_runtime_response",
          `Ignored an invalid openSession response: ${openedMismatch}`,
          true
        )
      };
    }

    if (initialPlan) {
      targetRuntimeIsCurrent =
        (isRLibraryCopy(initialPlan)
          ? delegate.captureSessionOwner?.(session.runtimeId)
          : delegate.captureFileSessionOwner?.(session.runtimeId)) ?? (() => false);
      const targetFailure = currentFailure();
      if (targetFailure) {
        await this.runtimeCleanup.close(session, "invalid open runtime");
        return { established: false, response: targetFailure };
      }
    }

    session.sourceSchema =
      request.source.kind === "file" &&
      (isFileDataBackend(response.metadata.backend) || response.metadata.backend === "r")
        ? structuredClone(response.metadata.schema)
        : undefined;
    const restored = initialPlan
      ? await this.restoreInitialPlan(session, request, initialPlan, currentFailure, options)
      : await this.restorePersistedSession(session, request, response, currentFailure, options);
    if ("reopenInEditing" in restored) {
      const editingRequest: OpenSessionRequest = {
        ...request,
        mode: "editing",
        ...(request.requestedSessionId === undefined ? {} : { requestedSessionId: randomUUID() })
      };
      return this.establish(delegate, editingRequest, options, origin, hooks, sourceProtection);
    }
    if (!restored.established) return restored;
    let established = false;
    try {
      if (session.sourceProtection) {
        session.sourceProtection = await confirmSessionSourceProtection(session.sourceProtection);
      }
      if (initialPlan && !isRLibraryCopy(initialPlan) && !session.sourceProtection?.available) {
        await this.runtimeCleanup.close(session, "late-open runtime");
        return {
          established: false,
          response: protocolError(
            "file_plan_target_changed",
            "The selected file changed while its plan was being saved. The copied plan may be saved; reopen the file to inspect it.",
            true
          )
        };
      }
      if (options?.requiredSourceProtection && !session.sourceProtection?.available) {
        await this.runtimeCleanup.close(session, "late-open runtime");
        return {
          established: false,
          response: protocolError("source_changed", "The selected file changed. Choose the file again.", true)
        };
      }
      const beforePublication = currentFailure();
      if (beforePublication) {
        await this.runtimeCleanup.close(session, "late-open runtime");
        return { established: false, response: beforePublication };
      }
      established = true;
      return {
        established: true,
        session,
        response: publicOpenedResponse(restored.response, publicId, session.publicRevision, session.openRequest.source)
      };
    } finally {
      if (!established && session.delegate !== delegate) this.runtimeCleanup.releaseIfIdle(session.delegate);
    }
  }

  private async restoreInitialPlan(
    session: RuntimeEstablishedSession,
    request: OpenSessionRequest,
    plan: InitialSessionPlan,
    currentFailure: () => OpenWranglerResponse | undefined,
    options?: BridgeRequestOptions
  ): Promise<RuntimeEstablishmentResult> {
    const assertCurrent = (): void => {
      if (currentFailure()) throw new RuntimeStateRestoreError("The originating plan is no longer current.");
    };
    const source = structuredClone(session.metadata.source);
    try {
      if (
        !session.metadata.capabilities.editable ||
        plan.steps.some((step) => !supportsOperation(session.metadata.capabilities, step.kind))
      )
        throw new RuntimeStateRestoreError("The selected file does not support every operation in this plan.");
      const steps = isRLibraryCopy(plan)
        ? structuredClone([...plan.steps])
        : await initialFilePlanSteps(plan, session.sourceSchema!, assertCurrent, options?.cancellation);
      const assertCompletePlan = (): void => {
        if (
          session.metadata.backend !== plan.backend ||
          (plan.backend === "r" && session.metadata.rLibrary !== (plan.rLibrary ?? "base")) ||
          session.metadata.mode !== "editing" ||
          !session.metadata.capabilities.editable ||
          !isDeepStrictEqual(session.metadata.source, source) ||
          !isDeepStrictEqual(session.metadata.steps, steps) ||
          session.metadata.draftStep ||
          (steps.length > 0 && !session.code.trim()) ||
          (isRLibraryCopy(plan) && session.metadata.canRedo === true)
        )
          throw new RuntimeStateRestoreError(
            "The runtime did not confirm the complete copied plan and generated code."
          );
      };
      await this.runtimeStateRestorer.restoreCleaningState(
        session,
        { steps },
        request.columnOffset,
        request.columnLimit,
        options,
        assertCurrent
      );
      assertCompletePlan();
      const page = await this.runtimeStateRestorer.restoreViewingState(
        session,
        undefined,
        request.pageSize,
        request.columnOffset,
        request.columnLimit,
        options,
        assertCurrent
      );
      assertCompletePlan();
      session.publicRevision = session.runtimeRevision;
      session.sourceProtection = await confirmSessionSourceProtection(session.sourceProtection!);
      await plan.assertTargetAvailable(request.source, session.sourceProtection);
      assertCurrent();
      if (!isRLibraryCopy(plan)) {
        const absent = this.persistence.checkAbsent(request.source, plan.backend, plan.rLibrary);
        if (absent.kind !== "absent") {
          await this.runtimeCleanup.close(session, "invalid open runtime");
          return {
            established: false,
            response: protocolError(
              absent.kind === "occupied" ? "file_plan_target_changed" : "persistence_unavailable",
              absent.kind === "occupied"
                ? "The target's saved state changed before the plan could be shown. Choose another file."
                : "Open Wrangler could not read workspace storage. Retry after storage is available.",
              true
            )
          };
        }
        session.copiedPlanPending = true;
        return {
          established: true,
          session,
          response: { kind: "sessionOpened", metadata: session.metadata, page: page.page, summaries: [] }
        };
      }
      const saved = await this.persistence.commitRuntimeReplacement(
        request.source,
        persistedSessionState(session.metadata, session.viewState),
        () => !currentFailure(),
        // This initial candidate stays private until the durable write succeeds.
        () => () => undefined,
        { requireAbsent: request.source.kind === "file" }
      );
      if (saved.kind !== "committed") {
        const response =
          currentFailure() ??
          protocolError(
            saved.kind === "unavailable" ? "persistence_unavailable" : "file_plan_target_changed",
            saved.kind === "unavailable"
              ? "Open Wrangler could not save the copied plan. Retry after workspace storage is available."
              : "The target's saved state changed before the plan could be saved. Choose another file.",
            true
          );
        await this.runtimeCleanup.close(session, "invalid open runtime");
        return {
          established: false,
          response
        };
      }
      return {
        established: true,
        session,
        response: { kind: "sessionOpened", metadata: session.metadata, page: page.page, summaries: [] }
      };
    } catch (error) {
      const response =
        currentFailure() ??
        (error instanceof FilePlanMappingDeclined
          ? protocolError(
              "file_plan_mapping_declined",
              "The plan was not copied because no column mapping was chosen. Close this tab and choose the file again to match its columns.",
              true
            )
          : protocolError(
              "file_plan_replay_failed",
              error instanceof RuntimeStateRestoreError
                ? error.message
                : "Open Wrangler could not finish copying this plan. The original session was kept.",
              true
            ));
      if (error instanceof DetachedBridgeRequestError) {
        this.runtimeCleanup.trackDelegateSettlement(
          session.delegate,
          error.settlement.then(() => this.runtimeCleanup.close(session, "invalid open runtime"))
        );
      } else {
        await this.runtimeCleanup.close(session, "invalid open runtime");
      }
      return {
        established: false,
        response
      };
    }
  }

  private async restorePersistedSession(
    session: RuntimeEstablishedSession,
    request: OpenSessionRequest,
    response: SessionOpenedResponse,
    currentFailure: () => OpenWranglerResponse | undefined,
    options?: BridgeRequestOptions
  ): Promise<RuntimeEstablishmentResult | { reopenInEditing: true }> {
    let opened: SessionOpenedResponse = { ...response, summaries: [] };
    const persisted = this.persistence.load(request.source, response.metadata.backend, response.metadata.rLibrary);
    if (!persisted) return { established: true, session, response: opened };
    if (response.metadata.mode === "viewing" && (persisted.cleaning.steps.length > 0 || persisted.cleaning.draftStep)) {
      await this.runtimeCleanup.close(session, "invalid open runtime");
      const afterClose = currentFailure();
      if (afterClose) return { established: false, response: afterClose };
      const fileSource = request.source.kind === "file" || request.source.kind === "documentVariable";
      if (request.mode !== "editing" && (fileSource || canRequestLiveSessionMode(response.metadata, "editing")))
        return { reopenInEditing: true };
      return {
        established: false,
        response: protocolError(
          "viewing_mode_unavailable",
          "This dataframe source supports Viewing only, so its saved cleaning steps or draft cannot be restored. Your saved work was kept.",
          true
        )
      };
    }
    const assertCurrent = (): void => {
      if (currentFailure()) throw new Error("The saved-state opening is no longer current.");
    };

    let cleaningRestored = false;
    try {
      await this.runtimeStateRestorer.restoreCleaningState(
        session,
        persisted.cleaning,
        request.columnOffset,
        request.columnLimit,
        options,
        assertCurrent
      );
      cleaningRestored = true;
    } catch (error) {
      if (error instanceof DetachedBridgeRequestError) {
        this.runtimeCleanup.trackDelegateSettlement(
          session.delegate,
          error.settlement.then(() => this.runtimeCleanup.close(session, "failed saved-state runtime"))
        );
        return {
          established: false,
          response:
            currentFailure() ??
            protocolError(
              "saved_plan_restore_failed",
              `Open Wrangler could not finish restoring the saved cleaning plan for ${request.source.label}.`,
              true
            )
        };
      }
      await this.runtimeCleanup.close(session, "saved-plan fallback runtime");
      const afterClose = currentFailure();
      if (afterClose) return { established: false, response: afterClose };
      const savedCleaning = structuredClone(persisted.cleaning);
      const restoreContext = error instanceof RuntimeStateRestoreError ? ` ${error.message}` : "";
      const restoreFailure = protocolError(
        "saved_plan_restore_failed",
        `Open Wrangler could not restore the saved cleaning plan for ${request.source.label}.${restoreContext} Saved history was kept. Retry opening the dataframe when the source and runtime are available.`,
        true
      );
      const resetIsCurrent = (): boolean =>
        !currentFailure() &&
        session.openRequest.source === request.source &&
        session.metadata.backend === response.metadata.backend &&
        session.metadata.rLibrary === response.metadata.rLibrary &&
        isDeepStrictEqual(
          this.persistence.load(request.source, response.metadata.backend, response.metadata.rLibrary)?.cleaning,
          savedCleaning
        );
      const resetAction = "Open Original and Reset Plan";
      const choice = await vscode.window.showWarningMessage(
        `Open Wrangler could not restore the saved cleaning plan for ${request.source.label}.${restoreContext} Opening original data will replace its saved cleaning plan and draft.`,
        { modal: true },
        resetAction
      );
      if (choice !== resetAction || !resetIsCurrent())
        return { established: false, response: currentFailure() ?? restoreFailure };
      let replacementDelegate: RuntimeRecoveryDelegateCandidate | undefined;
      let cleanSessionOpened = false;
      let accepted = false;
      try {
        if (session.metadata.backend === "r") {
          const factory = runtimeRecoveryDelegateFactory(session.delegate);
          if (!factory) return { established: false, response: restoreFailure };
          const created = await factory.createRuntimeRecoveryDelegate();
          if (created.delegate === session.delegate)
            throw new Error("Native-R reset must use a fresh verified runtime delegate.");
          replacementDelegate = created;
          if (!resetIsCurrent()) return { established: false, response: currentFailure() ?? restoreFailure };
          session.delegate = created.delegate;
        }
        const clean = await session.delegate.request(session.openRequest, options);
        if (clean.kind === "error" || clean.kind === "cancelled") return { established: false, response: clean };
        if (clean.kind !== "sessionOpened") {
          return {
            established: false,
            response: protocolError(
              "invalid_runtime_response",
              `The runtime returned ${clean.kind} while reopening the immutable source.`,
              true
            )
          };
        }
        cleanSessionOpened = true;
        session.runtimeId = clean.metadata.sessionId;
        session.runtimeRevision = clean.metadata.revision;
        session.publicRevision = clean.metadata.revision;
        session.metadata = clean.metadata;
        session.sourceSchema =
          request.source.kind === "file" &&
          (isFileDataBackend(clean.metadata.backend) || clean.metadata.backend === "r")
            ? structuredClone(clean.metadata.schema)
            : undefined;
        session.code = "";
        session.draftPresentation = undefined;
        session.draftBaseView = undefined;
        session.viewChangeEpoch = 0;
        session.viewState = initialViewingState(clean.metadata);
        const cleanMismatch = sessionOpenedResponseMismatch(session.openRequest, clean);
        if (cleanMismatch) {
          return {
            established: false,
            response: protocolError(
              "invalid_runtime_response",
              `Ignored an invalid openSession response while reopening the immutable source: ${cleanMismatch}`,
              true
            )
          };
        }
        opened = { ...clean, summaries: [] };
        const afterFallback = currentFailure();
        if (afterFallback) {
          return { established: false, response: afterFallback };
        }
        if (session.sourceProtection)
          session.sourceProtection = await confirmSessionSourceProtection(session.sourceProtection);
        if (!session.sourceProtection?.available) {
          return { established: false, response: currentFailure() ?? restoreFailure };
        }
        const reset = await this.persistence.commitCurrent(
          request.source,
          () => persistedSessionState(session.metadata, session.viewState),
          resetIsCurrent,
          // The candidate is unpublished, so a failed storage write has no live state to roll back.
          () => () => undefined
        );
        if (reset.kind !== "committed") {
          return {
            established: false,
            response:
              currentFailure() ??
              (reset.kind === "unavailable"
                ? protocolError(
                    "persistence_unavailable",
                    "Open Wrangler could not save the cleaning-plan reset. Retry after workspace storage is available.",
                    true
                  )
                : restoreFailure)
          };
        }
        accepted = true;
      } catch (error) {
        if (error instanceof DetachedBridgeRequestError) {
          const candidate = cleanSessionOpened ? { ...session } : undefined;
          const replacement = replacementDelegate;
          this.runtimeCleanup.trackDelegateSettlement(
            replacement?.delegate ?? session.delegate,
            error.settlement.then(() => discardRuntimeRecoveryCandidate(this.runtimeCleanup, candidate, replacement))
          );
          cleanSessionOpened = false;
          replacementDelegate = undefined;
          return { established: false, response: currentFailure() ?? restoreFailure };
        }
        throw error;
      } finally {
        if (!accepted)
          await discardRuntimeRecoveryCandidate(
            this.runtimeCleanup,
            cleanSessionOpened ? session : undefined,
            replacementDelegate
          );
      }
    }

    if (cleaningRestored) {
      let page: PageResponse;
      try {
        page = await this.runtimeStateRestorer.restoreViewingState(
          session,
          persisted.view,
          request.pageSize,
          request.columnOffset,
          request.columnLimit,
          options,
          assertCurrent
        );
      } catch (error) {
        if (error instanceof DetachedBridgeRequestError) {
          this.runtimeCleanup.trackDelegateSettlement(
            session.delegate,
            error.settlement.then(() => this.runtimeCleanup.close(session, "failed saved-state runtime"))
          );
        } else {
          await this.runtimeCleanup.close(session, "failed saved-state runtime");
        }
        return {
          established: false,
          response:
            currentFailure() ??
            protocolError(
              "saved_view_restore_failed",
              `Open Wrangler could not restore a confirmed view for ${request.source.label}.`,
              true
            )
        };
      }
      session.publicRevision = session.runtimeRevision;
      opened = {
        kind: "sessionOpened",
        metadata: session.metadata,
        page: page.page,
        summaries: []
      };
    }
    return { established: true, session, response: opened };
  }
}
