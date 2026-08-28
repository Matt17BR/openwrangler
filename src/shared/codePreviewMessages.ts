import { isRuntimeIdentity, type RuntimeIdentity } from "./runtimeIdentity";
import { isValidCodePreviewText } from "./codePreviewLimits";

export type CodePreviewHostMessage =
  | {
      readonly kind: "codePreview";
      readonly bufferId: string;
      readonly bufferInvalid: boolean;
      readonly code: string;
      readonly editable: boolean;
      readonly runtimeIdentity: RuntimeIdentity | null;
    }
  | { readonly kind: "codeSnapshotRequest"; readonly requestId: string; readonly bufferId: string };

export type CodePreviewWebviewMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "codeChanged"; readonly bufferId: string; readonly code: string }
  | { readonly kind: "codeChangedInvalid"; readonly bufferId: string }
  | { readonly kind: "codeSnapshot"; readonly requestId: string; readonly bufferId: string; readonly code: string }
  | { readonly kind: "codeSnapshotInvalid"; readonly requestId: string; readonly bufferId: string };

export function isCodePreviewHostMessage(value: unknown): value is CodePreviewHostMessage {
  if (
    hasExactKeys(value, ["kind", "requestId", "bufferId"]) &&
    value.kind === "codeSnapshotRequest" &&
    isUuid(value.requestId) &&
    isUuid(value.bufferId)
  ) {
    return true;
  }
  if (!hasExactKeys(value, ["kind", "bufferId", "bufferInvalid", "code", "editable", "runtimeIdentity"])) {
    return false;
  }
  if (
    value.kind !== "codePreview" ||
    !isUuid(value.bufferId) ||
    typeof value.bufferInvalid !== "boolean" ||
    typeof value.code !== "string" ||
    !isValidCodePreviewText(value.code) ||
    typeof value.editable !== "boolean"
  ) {
    return false;
  }
  if (value.runtimeIdentity !== null && !isRuntimeIdentity(value.runtimeIdentity)) return false;
  return !value.editable || (value.runtimeIdentity !== null && value.runtimeIdentity.codeDialect !== null);
}

export function isCodePreviewWebviewMessage(value: unknown): value is CodePreviewWebviewMessage {
  if (hasExactKeys(value, ["kind"])) return value.kind === "ready";
  if (hasExactKeys(value, ["kind", "bufferId"])) {
    return value.kind === "codeChangedInvalid" && isUuid(value.bufferId);
  }
  if (hasExactKeys(value, ["kind", "bufferId", "code"])) {
    return (
      value.kind === "codeChanged" &&
      isUuid(value.bufferId) &&
      typeof value.code === "string" &&
      isValidCodePreviewText(value.code)
    );
  }
  if (hasExactKeys(value, ["kind", "requestId", "bufferId"])) {
    return value.kind === "codeSnapshotInvalid" && isUuid(value.requestId) && isUuid(value.bufferId);
  }
  return (
    hasExactKeys(value, ["kind", "requestId", "bufferId", "code"]) &&
    value.kind === "codeSnapshot" &&
    isUuid(value.requestId) &&
    isUuid(value.bufferId) &&
    typeof value.code === "string" &&
    isValidCodePreviewText(value.code)
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
