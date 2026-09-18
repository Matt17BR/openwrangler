import {
  isRLibrary,
  type DataBackend,
  type FilterModel,
  type RLibrary,
  type SessionMetadata,
  type SessionSource,
  type TransformStep
} from "../shared/protocol";
import { isFilterModel, isRetainedTransformStep } from "../shared/protocolValidation";
import {
  decodeGridViewState,
  encodeGridViewState,
  type GridViewState,
  type PersistedViewingState,
  type SerializedGridViewState
} from "../shared/viewState";

export const SESSION_STORAGE_KEY = "openWrangler.persistedSessions.v4";

export interface PersistedCleaningState {
  steps: TransformStep[];
  draftStep?: TransformStep;
  draftReplacesStepId?: string;
  draftBaseFilterModel?: FilterModel;
}

export interface PersistedSessionState {
  backend: DataBackend;
  rLibrary?: RLibrary;
  cleaning: PersistedCleaningState;
  view: PersistedViewingState;
}

export interface SerializedPersistedSessionState {
  backend: DataBackend;
  rLibrary?: RLibrary;
  cleaning: PersistedCleaningState;
  view: SerializedGridViewState & { filterModel: FilterModel };
}

export interface DecodedPersistedSessionState {
  backend: DataBackend;
  rLibrary?: RLibrary;
  cleaning: PersistedCleaningState;
  view?: PersistedViewingState;
}

export function persistenceKey(source: SessionSource, backend: DataBackend, rLibrary?: RLibrary): string {
  return JSON.stringify({
    backend,
    ...(backend === "r" && rLibrary !== undefined && rLibrary !== "base" ? { rLibrary } : {}),
    kind: source.kind,
    path: source.path ?? null,
    uri: source.uri ?? null,
    variableName: source.variableName ?? null,
    label: source.label,
    importOptions: source.importOptions ?? null
  });
}

export function persistedSessionState(
  metadata: SessionMetadata,
  gridViewState: GridViewState,
  draftBaseFilterModel?: FilterModel
): PersistedSessionState {
  return {
    backend: metadata.backend,
    ...(metadata.backend === "r" ? { rLibrary: metadata.rLibrary } : {}),
    cleaning: {
      steps: metadata.steps,
      draftStep: metadata.draftStep,
      draftReplacesStepId: metadata.draftReplacesStepId,
      ...(metadata.draftStep && draftBaseFilterModel ? { draftBaseFilterModel } : {})
    },
    view: {
      ...gridViewState,
      columnWidths: new Map(gridViewState.columnWidths),
      viewport: { ...gridViewState.viewport },
      filterModel: metadata.filterModel
    }
  };
}

export function serializePersistedSession(state: PersistedSessionState): SerializedPersistedSessionState | undefined {
  const serializedViewState = encodeGridViewState(state.view);
  return serializedViewState
    ? {
        backend: state.backend,
        ...(state.backend === "r" && state.rLibrary !== undefined ? { rLibrary: state.rLibrary } : {}),
        cleaning: state.cleaning,
        view: { ...serializedViewState, filterModel: state.view.filterModel }
      }
    : undefined;
}

export function decodePersistedSession(value: unknown): DecodedPersistedSessionState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["backend", "cleaning"], ["view", "rLibrary"]) ||
    !isPersistableDataBackend(value.backend) ||
    (Object.hasOwn(value, "rLibrary") && (value.backend !== "r" || !isRLibrary(value.rLibrary))) ||
    !isRecord(value.cleaning) ||
    !hasExactKeys(value.cleaning, ["steps"], ["draftStep", "draftReplacesStepId", "draftBaseFilterModel"]) ||
    !Array.isArray(value.cleaning.steps)
  ) {
    return undefined;
  }
  const steps = value.cleaning.steps.map(decodeStep);
  if (steps.some((step) => step === undefined)) return undefined;
  const draftStep = value.cleaning.draftStep === undefined ? undefined : decodeStep(value.cleaning.draftStep);
  if (value.cleaning.draftStep !== undefined && !draftStep) return undefined;
  const draftReplacesStepId = value.cleaning.draftReplacesStepId;
  if (draftReplacesStepId !== undefined && (typeof draftReplacesStepId !== "string" || !draftReplacesStepId)) {
    return undefined;
  }
  const draftBaseFilterModel =
    draftStep && isFilterModel(value.cleaning.draftBaseFilterModel) ? value.cleaning.draftBaseFilterModel : undefined;
  const view = decodePersistedView(value.view);
  return {
    backend: value.backend,
    ...(value.backend === "r" ? { rLibrary: (value.rLibrary ?? "base") as RLibrary } : {}),
    cleaning: {
      steps: steps as TransformStep[],
      draftStep,
      draftReplacesStepId,
      ...(draftBaseFilterModel ? { draftBaseFilterModel } : {})
    },
    ...(view ? { view } : {})
  };
}

function decodePersistedView(value: unknown): PersistedViewingState | undefined {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["filterModel", "columnWidths", "viewport"], ["selectedColumnId"]) ||
    !isFilterModel(value.filterModel)
  ) {
    return undefined;
  }
  const gridViewState = decodeGridViewState({
    columnWidths: value.columnWidths,
    ...(value.selectedColumnId === undefined ? {} : { selectedColumnId: value.selectedColumnId }),
    viewport: value.viewport
  });
  return gridViewState ? { ...gridViewState, filterModel: value.filterModel } : undefined;
}

function isPersistableDataBackend(value: unknown): value is Extract<DataBackend, "pandas" | "polars" | "duckdb" | "r"> {
  return value === "polars" || value === "duckdb" || value === "pandas" || value === "r";
}

function decodeStep(value: unknown): TransformStep | undefined {
  return isRetainedTransformStep(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}
