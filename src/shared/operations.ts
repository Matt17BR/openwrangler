import type { OperationKind, SessionMetadata, SourceCapabilities, TransformStep } from "./protocol";
import { operationCatalog, type OperationCatalogItem } from "./operationCatalog.generated";

export {
  operationCatalog,
  operationGroups,
  type OperationCatalogItem,
  type OperationGroup
} from "./operationCatalog.generated";

export function operationByKind(kind: OperationKind): OperationCatalogItem {
  const operation = operationCatalog.find((candidate) => candidate.kind === kind);
  if (!operation) throw new Error(`Unknown operation: ${kind}`);
  return operation;
}

export function supportsOperation(capabilities: SourceCapabilities | undefined, kind: OperationKind): boolean {
  return capabilities?.supportedOperations?.includes(kind) ?? true;
}

export function supportedOperationCatalog(
  capabilities: SourceCapabilities | undefined
): readonly OperationCatalogItem[] {
  return capabilities?.supportedOperations === undefined
    ? operationCatalog
    : operationCatalog.filter((operation) => supportsOperation(capabilities, operation.kind));
}

type OperationEntryMetadata = {
  mode: SessionMetadata["mode"];
  draftStep?: TransformStep;
  capabilities?: SourceCapabilities;
};

export function canStartOperation(metadata: OperationEntryMetadata | undefined, kind?: OperationKind): boolean {
  if (metadata?.mode !== "editing" || metadata.draftStep !== undefined) return false;
  return kind === undefined
    ? supportedOperationCatalog(metadata.capabilities).length > 0
    : supportsOperation(metadata.capabilities, kind);
}

export function canEditLatestStep(
  metadata: (OperationEntryMetadata & Pick<SessionMetadata, "steps">) | undefined
): boolean {
  const latest = metadata?.steps.at(-1);
  return latest !== undefined && canStartOperation(metadata, latest.kind);
}
