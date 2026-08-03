import { isRuntimeIdentity, type RuntimeIdentity } from "./runtimeIdentity";

export interface CodePreviewHostMessage {
  readonly kind: "codePreview";
  readonly code: string;
  readonly editable: boolean;
  readonly runtimeIdentity: RuntimeIdentity | null;
}

export type CodePreviewWebviewMessage =
  { readonly kind: "ready" } | { readonly kind: "codeChanged"; readonly code: string };

export function isCodePreviewHostMessage(value: unknown): value is CodePreviewHostMessage {
  if (!hasExactKeys(value, ["kind", "code", "editable", "runtimeIdentity"])) return false;
  if (value.kind !== "codePreview" || typeof value.code !== "string" || typeof value.editable !== "boolean") {
    return false;
  }
  if (value.runtimeIdentity !== null && !isRuntimeIdentity(value.runtimeIdentity)) return false;
  return !value.editable || (value.runtimeIdentity !== null && value.runtimeIdentity.codeDialect !== null);
}

export function isCodePreviewWebviewMessage(value: unknown): value is CodePreviewWebviewMessage {
  if (hasExactKeys(value, ["kind"])) return value.kind === "ready";
  return hasExactKeys(value, ["kind", "code"]) && value.kind === "codeChanged" && typeof value.code === "string";
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
