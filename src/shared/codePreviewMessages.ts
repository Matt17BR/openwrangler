import { isRuntimeIdentity, type RuntimeIdentity } from "./runtimeIdentity";
import {
  CODE_PREVIEW_MAX_EDIT_CHANGES,
  CODE_PREVIEW_MAX_UTF8_BYTES,
  codePreviewUtf8ByteLength,
  isCanonicalCodePreviewText
} from "./codePreviewLimits";

export interface CodePreviewChange {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export type CodePreviewHostMessage =
  | {
      readonly kind: "codePreview";
      readonly bufferId: string;
      readonly bufferVersion: number;
      readonly bufferInvalid: boolean;
      readonly code: string;
      readonly editable: boolean;
      readonly runtimeIdentity: RuntimeIdentity | null;
    }
  | {
      readonly kind: "codeSnapshotRequest";
      readonly requestId: string;
      readonly bufferId: string;
      readonly bufferVersion: number;
    };

export type CodePreviewWebviewMessage =
  | { readonly kind: "ready" }
  | {
      readonly kind: "codeChanged";
      readonly bufferId: string;
      readonly baseVersion: number;
      readonly bufferVersion: number;
      readonly changes: readonly CodePreviewChange[];
    }
  | { readonly kind: "codeChangedInvalid"; readonly bufferId: string; readonly baseVersion: number }
  | {
      readonly kind: "codeSnapshot";
      readonly requestId: string;
      readonly bufferId: string;
      readonly baseVersion: number;
      readonly bufferVersion: number;
      readonly code: string;
    }
  | {
      readonly kind: "codeSnapshotInvalid";
      readonly requestId: string;
      readonly bufferId: string;
      readonly baseVersion: number;
    };

export function isCodePreviewHostMessage(value: unknown): value is CodePreviewHostMessage {
  if (
    hasExactKeys(value, ["kind", "requestId", "bufferId", "bufferVersion"]) &&
    value.kind === "codeSnapshotRequest" &&
    isUuid(value.requestId) &&
    isUuid(value.bufferId) &&
    isBufferVersion(value.bufferVersion)
  ) {
    return true;
  }
  if (
    !hasExactKeys(value, ["kind", "bufferId", "bufferVersion", "bufferInvalid", "code", "editable", "runtimeIdentity"])
  ) {
    return false;
  }
  if (
    value.kind !== "codePreview" ||
    !isUuid(value.bufferId) ||
    !isBufferVersion(value.bufferVersion) ||
    typeof value.bufferInvalid !== "boolean" ||
    typeof value.code !== "string" ||
    !isCanonicalCodePreviewText(value.code) ||
    typeof value.editable !== "boolean"
  ) {
    return false;
  }
  if (value.runtimeIdentity !== null && !isRuntimeIdentity(value.runtimeIdentity)) return false;
  return !value.editable || (value.runtimeIdentity !== null && value.runtimeIdentity.codeDialect !== null);
}

export function isCodePreviewWebviewMessage(value: unknown): value is CodePreviewWebviewMessage {
  if (hasExactKeys(value, ["kind"])) return value.kind === "ready";
  if (hasExactKeys(value, ["kind", "bufferId", "baseVersion"])) {
    return value.kind === "codeChangedInvalid" && isUuid(value.bufferId) && isBufferVersion(value.baseVersion);
  }
  if (hasExactKeys(value, ["kind", "bufferId", "baseVersion", "bufferVersion", "changes"])) {
    return (
      value.kind === "codeChanged" &&
      isUuid(value.bufferId) &&
      isBufferVersion(value.baseVersion) &&
      isBufferVersion(value.bufferVersion) &&
      isCodePreviewChanges(value.changes) &&
      value.bufferVersion === value.baseVersion + (value.changes.length === 0 ? 0 : 1)
    );
  }
  if (hasExactKeys(value, ["kind", "requestId", "bufferId", "baseVersion"])) {
    return (
      value.kind === "codeSnapshotInvalid" &&
      isUuid(value.requestId) &&
      isUuid(value.bufferId) &&
      isBufferVersion(value.baseVersion)
    );
  }
  return (
    hasExactKeys(value, ["kind", "requestId", "bufferId", "baseVersion", "bufferVersion", "code"]) &&
    value.kind === "codeSnapshot" &&
    isUuid(value.requestId) &&
    isUuid(value.bufferId) &&
    isBufferVersion(value.baseVersion) &&
    isBufferVersion(value.bufferVersion) &&
    value.bufferVersion >= value.baseVersion &&
    typeof value.code === "string" &&
    isCanonicalCodePreviewText(value.code)
  );
}

function isCodePreviewChanges(value: unknown): value is readonly CodePreviewChange[] {
  if (!Array.isArray(value) || value.length > CODE_PREVIEW_MAX_EDIT_CHANGES) return false;
  let previousTo = 0;
  let remainingInsertBytes = CODE_PREVIEW_MAX_UTF8_BYTES;
  for (const change of value) {
    if (
      !hasExactKeys(change, ["from", "to", "insert"]) ||
      !isCodePosition(change.from) ||
      !isCodePosition(change.to) ||
      change.from > change.to ||
      change.from < previousTo ||
      typeof change.insert !== "string" ||
      (change.from === change.to && change.insert.length === 0)
    ) {
      return false;
    }
    if (change.insert.includes("\r")) return false;
    const insertBytes = codePreviewUtf8ByteLength(change.insert, remainingInsertBytes);
    if (insertBytes === undefined) return false;
    remainingInsertBytes -= insertBytes;
    previousTo = change.to;
  }
  return true;
}

function isCodePosition(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= CODE_PREVIEW_MAX_UTF8_BYTES;
}

function isBufferVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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
