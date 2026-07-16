import type { DataBackend, FilterModel, SessionMetadata, SessionSource, TransformStep } from "../shared/protocol";
import { isFilterModel, isTransformStep } from "../shared/protocolValidation";

export const SESSION_STORAGE_KEY = "openWrangler.persistedSessions.v3";

export interface PersistedSessionState {
  backend: DataBackend;
  steps: TransformStep[];
  filterModel: FilterModel;
  draftStep?: TransformStep;
  draftReplacesStepId?: string;
}

export function persistenceKey(source: SessionSource, backend: DataBackend): string {
  return JSON.stringify({
    backend,
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
    backend: metadata.backend,
    steps: metadata.steps,
    filterModel: metadata.filterModel,
    draftStep: metadata.draftStep,
    draftReplacesStepId: metadata.draftReplacesStepId
  };
}

export function decodePersistedSession(value: unknown): PersistedSessionState | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["backend", "steps", "filterModel", "draftStep", "draftReplacesStepId"].includes(key)
    ) ||
    !isDataBackend(value.backend) ||
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
    backend: value.backend,
    steps: steps as TransformStep[],
    filterModel: value.filterModel,
    draftStep,
    draftReplacesStepId
  };
}

function isDataBackend(value: unknown): value is DataBackend {
  return value === "polars" || value === "duckdb" || value === "pandas";
}

function decodeStep(value: unknown): TransformStep | undefined {
  return isTransformStep(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
