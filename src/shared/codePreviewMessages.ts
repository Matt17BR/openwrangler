import {
  CODE_PREVIEW_EDIT_COALESCE_MS,
  type CodePreviewInvalidReason,
  type CodePreviewTextResult,
  validateCodePreviewText
} from "./codePreviewLimits";
import { isRuntimeIdentity, type RuntimeIdentity } from "./runtimeIdentity";

export type CodePreviewHostMessage =
  | {
      readonly kind: "codePreview";
      readonly generation: number;
      readonly code: string;
      readonly editable: boolean;
      readonly runtimeIdentity: RuntimeIdentity | null;
    }
  | {
      readonly kind: "codePreviewInvalid";
      readonly generation: number;
      readonly reason: CodePreviewInvalidReason;
      readonly editable: boolean;
      readonly runtimeIdentity: RuntimeIdentity | null;
    };

export type CodePreviewWebviewMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "codeChanged"; readonly generation: number; readonly sequence: number; readonly code: string }
  | {
      readonly kind: "codeInvalid";
      readonly generation: number;
      readonly sequence: number;
      readonly reason: CodePreviewInvalidReason;
    };

export interface CodePreviewEditScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export class CodePreviewEditCoalescer {
  private generation = 0;
  private sequence = 0;
  private pending = false;
  private timerScheduled = false;
  private timer: unknown;

  constructor(
    private readonly readCode: () => CodePreviewTextResult,
    private readonly publish: (message: CodePreviewWebviewMessage) => void,
    private readonly scheduler: CodePreviewEditScheduler
  ) {}

  acceptGeneration(generation: number): void {
    if (!isPositiveSafeInteger(generation) || generation === this.generation) return;
    this.cancelPending();
    this.generation = generation;
    this.sequence = 0;
  }

  schedule(): void {
    if (this.generation === 0) return;
    this.pending = true;
    if (this.timerScheduled) return;
    this.timerScheduled = true;
    this.timer = this.scheduler.schedule(() => this.flush(), CODE_PREVIEW_EDIT_COALESCE_MS);
  }

  dispose(): void {
    this.cancelPending();
    this.generation = 0;
    this.sequence = 0;
  }

  private flush(): void {
    this.timerScheduled = false;
    this.timer = undefined;
    if (!this.pending || this.generation === 0) return;
    this.pending = false;
    this.sequence += 1;
    const result = this.readCode();
    this.publish(
      result.valid
        ? { kind: "codeChanged", generation: this.generation, sequence: this.sequence, code: result.code }
        : { kind: "codeInvalid", generation: this.generation, sequence: this.sequence, reason: result.reason }
    );
  }

  private cancelPending(): void {
    if (this.timerScheduled) this.scheduler.cancel(this.timer);
    this.timerScheduled = false;
    this.timer = undefined;
    this.pending = false;
  }
}

export function isCodePreviewHostMessage(value: unknown): value is CodePreviewHostMessage {
  if (!hasExactKeys(value, ["kind", "generation", "code", "editable", "runtimeIdentity"])) {
    if (!hasExactKeys(value, ["kind", "generation", "reason", "editable", "runtimeIdentity"])) return false;
    if (
      value.kind !== "codePreviewInvalid" ||
      !isPositiveSafeInteger(value.generation) ||
      !isCodePreviewInvalidReason(value.reason) ||
      typeof value.editable !== "boolean"
    ) {
      return false;
    }
    if (value.runtimeIdentity !== null && !isRuntimeIdentity(value.runtimeIdentity)) return false;
    return !value.editable || (value.runtimeIdentity !== null && value.runtimeIdentity.codeDialect !== null);
  }
  if (
    value.kind !== "codePreview" ||
    !isPositiveSafeInteger(value.generation) ||
    typeof value.code !== "string" ||
    !validateCodePreviewText(value.code).valid ||
    typeof value.editable !== "boolean"
  ) {
    return false;
  }
  if (value.runtimeIdentity !== null && !isRuntimeIdentity(value.runtimeIdentity)) return false;
  return !value.editable || (value.runtimeIdentity !== null && value.runtimeIdentity.codeDialect !== null);
}

export function isCodePreviewWebviewMessage(value: unknown): value is CodePreviewWebviewMessage {
  if (hasExactKeys(value, ["kind"])) return value.kind === "ready";
  if (hasExactKeys(value, ["kind", "generation", "sequence", "code"])) {
    return (
      value.kind === "codeChanged" &&
      isPositiveSafeInteger(value.generation) &&
      isPositiveSafeInteger(value.sequence) &&
      typeof value.code === "string" &&
      validateCodePreviewText(value.code).valid
    );
  }
  return (
    hasExactKeys(value, ["kind", "generation", "sequence", "reason"]) &&
    value.kind === "codeInvalid" &&
    isPositiveSafeInteger(value.generation) &&
    isPositiveSafeInteger(value.sequence) &&
    isCodePreviewInvalidReason(value.reason)
  );
}

function isCodePreviewInvalidReason(value: unknown): value is CodePreviewInvalidReason {
  return value === "codePoints" || value === "invalidUnicode" || value === "utf8Bytes";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
