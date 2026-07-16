import type { FilterModel, SessionMetadata, SessionSource, TransformStep } from "../shared/protocol";
import { isFilterModel, isTransformStep } from "../shared/protocolValidation";

export const SESSION_STORAGE_KEY = "openWrangler.persistedSessions.v2";

export interface PersistedSessionState {
  steps: TransformStep[];
  filterModel: FilterModel;
  draftStep?: TransformStep;
  draftReplacesStepId?: string;
}

export function persistenceKey(source: SessionSource): string {
  return JSON.stringify({
    kind: source.kind,
    path: source.path ?? null,
    uri: source.uri ?? null,
    variableName: source.variableName ?? null,
    label: source.label,
    importOptions: source.importOptions ?? null
  });
}

export function persistedStateFromMetadata(metadata: SessionMetadata): PersistedSessionState {
  return {
    steps: metadata.steps,
    filterModel: metadata.filterModel,
    draftStep: metadata.draftStep,
    draftReplacesStepId: metadata.draftReplacesStepId
  };
}

export function decodePersistedSession(value: unknown): PersistedSessionState | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !["steps", "filterModel", "draftStep", "draftReplacesStepId"].includes(key)) ||
    !Array.isArray(value.steps) ||
    !isFilterModel(value.filterModel)
  ) {
    return undefined;
  }
  const steps = value.steps.map(decodeStep);
  if (steps.some((step) => step === undefined)) return undefined;
  const draftStep = value.draftStep === undefined ? undefined : decodeStep(value.draftStep);
  if (value.draftStep !== undefined && !draftStep) return undefined;
  const draftReplacesStepId = value.draftReplacesStepId;
  if (draftReplacesStepId !== undefined && (typeof draftReplacesStepId !== "string" || !draftReplacesStepId)) {
    return undefined;
  }
  return {
    steps: steps as TransformStep[],
    filterModel: value.filterModel,
    draftStep,
    draftReplacesStepId
  };
}

function decodeStep(value: unknown): TransformStep | undefined {
  return isTransformStep(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
