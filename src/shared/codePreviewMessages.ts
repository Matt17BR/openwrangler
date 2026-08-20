import {
  CODE_PREVIEW_EDIT_COALESCE_MS,
  type CodePreviewInvalidReason,
  type CodePreviewTextResult,
  validateCodePreviewText
} from "./codePreviewLimits";
import { isRuntimeIdentity, type RuntimeIdentity } from "./runtimeIdentity";

export type CodePreviewUnavailableReason =
  "disposed" | "generationExhausted" | "generationMismatch" | "sequenceExhausted";

interface CodePreviewHostState {
  readonly generation: number;
  readonly acknowledgedSequence: number;
  readonly editable: boolean;
  readonly runtimeIdentity: RuntimeIdentity | null;
}

export type CodePreviewHostMessage =
  | (CodePreviewHostState & { readonly kind: "codePreview"; readonly code: string })
  | (CodePreviewHostState & { readonly kind: "codePreviewInvalid"; readonly reason: CodePreviewInvalidReason })
  | (CodePreviewHostState & {
      readonly kind: "codePreviewUnavailable";
      readonly reason: "generationExhausted";
      readonly editable: false;
    })
  | {
      readonly kind: "codePreviewSnapshotRequest";
      readonly generation: number;
      readonly requestId: string;
    };

export type CodePreviewWebviewMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "codePending"; readonly generation: number; readonly sequence: number }
  | { readonly kind: "codeChanged"; readonly generation: number; readonly sequence: number; readonly code: string }
  | {
      readonly kind: "codeInvalid";
      readonly generation: number;
      readonly sequence: number;
      readonly reason: CodePreviewInvalidReason;
    }
  | {
      readonly kind: "codeSnapshot";
      readonly generation: number;
      readonly sequence: number;
      readonly requestId: string;
      readonly code: string;
    }
  | {
      readonly kind: "codeSnapshotInvalid";
      readonly generation: number;
      readonly sequence: number;
      readonly requestId: string;
      readonly reason: CodePreviewInvalidReason;
    }
  | {
      readonly kind: "codeSnapshotUnavailable";
      readonly generation: number;
      readonly requestId: string;
      readonly reason: "disposed" | "generationMismatch" | "sequenceExhausted";
    }
  | {
      readonly kind: "codePreviewUnavailable";
      readonly generation: number;
      readonly reason: "disposed" | "sequenceExhausted";
    };

export interface CodePreviewEditScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

export type NextCodePreviewGeneration =
  | { readonly available: true; readonly generation: number }
  | { readonly available: false; readonly generation: typeof Number.MAX_SAFE_INTEGER };

export function nextCodePreviewGeneration(current: number): NextCodePreviewGeneration {
  if (!isNonNegativeSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER - 1) {
    return { available: false, generation: Number.MAX_SAFE_INTEGER };
  }
  return { available: true, generation: current + 1 };
}

export class CodePreviewEditCoalescer {
  private generation = 0;
  private sequence = 0;
  private acknowledgedSequence = 0;
  private pending = false;
  private invalidated = false;
  private timerScheduled = false;
  private timer: unknown;

  constructor(
    private readonly readCode: () => CodePreviewTextResult,
    private readonly publish: (message: CodePreviewWebviewMessage) => void,
    private readonly scheduler: CodePreviewEditScheduler
  ) {}

  acceptHostState(generation: number, acknowledgedSequence: number): boolean {
    if (
      this.invalidated ||
      !isPositiveSafeInteger(generation) ||
      !isNonNegativeSafeInteger(acknowledgedSequence) ||
      generation < this.generation
    ) {
      return false;
    }
    if (generation > this.generation) {
      this.cancelPending();
      this.generation = generation;
      this.sequence = acknowledgedSequence;
      this.acknowledgedSequence = acknowledgedSequence;
      return true;
    }
    if (acknowledgedSequence < this.acknowledgedSequence || acknowledgedSequence > this.sequence) return false;
    this.acknowledgedSequence = acknowledgedSequence;
    return !this.pending && this.sequence === this.acknowledgedSequence;
  }

  schedule(): void {
    if (this.generation === 0 || this.invalidated) return;
    if (!this.pending) {
      if (this.sequence === Number.MAX_SAFE_INTEGER) {
        this.invalidate("sequenceExhausted");
        return;
      }
      this.sequence += 1;
      this.pending = true;
      this.publish({ kind: "codePending", generation: this.generation, sequence: this.sequence });
    }
    if (this.timerScheduled) return;
    this.timerScheduled = true;
    this.timer = this.scheduler.schedule(() => this.flush(), CODE_PREVIEW_EDIT_COALESCE_MS);
  }

  respondToSnapshotRequest(generation: number, requestId: string): void {
    if (!isPositiveSafeInteger(generation) || !isCodePreviewRequestId(requestId)) return;
    if (this.invalidated) {
      this.publish({ kind: "codeSnapshotUnavailable", generation, requestId, reason: "disposed" });
      return;
    }
    if (generation !== this.generation) {
      this.publish({ kind: "codeSnapshotUnavailable", generation, requestId, reason: "generationMismatch" });
      return;
    }
    this.cancelTimer();
    this.pending = false;
    const result = this.readCode();
    this.publish(
      result.valid
        ? { kind: "codeSnapshot", generation, sequence: this.sequence, requestId, code: result.code }
        : {
            kind: "codeSnapshotInvalid",
            generation,
            sequence: this.sequence,
            requestId,
            reason: result.reason
          }
    );
  }

  invalidate(reason: "disposed" | "sequenceExhausted" = "disposed"): void {
    if (this.invalidated) return;
    this.cancelPending();
    this.invalidated = true;
    if (this.generation > 0) {
      this.publish({ kind: "codePreviewUnavailable", generation: this.generation, reason });
    }
  }

  hasUnacknowledgedEdit(): boolean {
    return this.pending || this.sequence > this.acknowledgedSequence;
  }

  dispose(): void {
    this.invalidate("disposed");
  }

  private flush(): void {
    this.timerScheduled = false;
    this.timer = undefined;
    if (!this.pending || this.generation === 0 || this.invalidated) return;
    this.pending = false;
    const result = this.readCode();
    this.publish(
      result.valid
        ? { kind: "codeChanged", generation: this.generation, sequence: this.sequence, code: result.code }
        : { kind: "codeInvalid", generation: this.generation, sequence: this.sequence, reason: result.reason }
    );
  }

  private cancelTimer(): void {
    if (this.timerScheduled) this.scheduler.cancel(this.timer);
    this.timerScheduled = false;
    this.timer = undefined;
  }

  private cancelPending(): void {
    this.cancelTimer();
    this.pending = false;
  }
}

export function isCodePreviewHostMessage(value: unknown): value is CodePreviewHostMessage {
  if (hasExactKeys(value, ["kind", "generation", "requestId"])) {
    return (
      value.kind === "codePreviewSnapshotRequest" &&
      isPositiveSafeInteger(value.generation) &&
      isCodePreviewRequestId(value.requestId)
    );
  }
  if (!hasValidHostState(value)) return false;
  if (hasExactKeys(value, ["kind", "generation", "acknowledgedSequence", "code", "editable", "runtimeIdentity"])) {
    return value.kind === "codePreview" && typeof value.code === "string" && validateCodePreviewText(value.code).valid;
  }
  if (hasExactKeys(value, ["kind", "generation", "acknowledgedSequence", "reason", "editable", "runtimeIdentity"])) {
    if (value.kind === "codePreviewInvalid") return isCodePreviewInvalidReason(value.reason);
    return (
      value.kind === "codePreviewUnavailable" && value.reason === "generationExhausted" && value.editable === false
    );
  }
  return false;
}

export function isCodePreviewWebviewMessage(value: unknown): value is CodePreviewWebviewMessage {
  if (hasExactKeys(value, ["kind"])) return value.kind === "ready";
  if (hasExactKeys(value, ["kind", "generation", "sequence"])) {
    return value.kind === "codePending" && hasValidEditIdentity(value);
  }
  if (hasExactKeys(value, ["kind", "generation", "sequence", "code"])) {
    return (
      value.kind === "codeChanged" &&
      hasValidEditIdentity(value) &&
      typeof value.code === "string" &&
      validateCodePreviewText(value.code).valid
    );
  }
  if (hasExactKeys(value, ["kind", "generation", "sequence", "reason"])) {
    return value.kind === "codeInvalid" && hasValidEditIdentity(value) && isCodePreviewInvalidReason(value.reason);
  }
  if (hasExactKeys(value, ["kind", "generation", "sequence", "requestId", "code"])) {
    return (
      value.kind === "codeSnapshot" &&
      isPositiveSafeInteger(value.generation) &&
      isNonNegativeSafeInteger(value.sequence) &&
      isCodePreviewRequestId(value.requestId) &&
      typeof value.code === "string" &&
      validateCodePreviewText(value.code).valid
    );
  }
  if (hasExactKeys(value, ["kind", "generation", "sequence", "requestId", "reason"])) {
    return (
      value.kind === "codeSnapshotInvalid" &&
      isPositiveSafeInteger(value.generation) &&
      isNonNegativeSafeInteger(value.sequence) &&
      isCodePreviewRequestId(value.requestId) &&
      isCodePreviewInvalidReason(value.reason)
    );
  }
  if (hasExactKeys(value, ["kind", "generation", "requestId", "reason"])) {
    return (
      value.kind === "codeSnapshotUnavailable" &&
      isPositiveSafeInteger(value.generation) &&
      isCodePreviewRequestId(value.requestId) &&
      (value.reason === "disposed" || value.reason === "generationMismatch" || value.reason === "sequenceExhausted")
    );
  }
  return (
    hasExactKeys(value, ["kind", "generation", "reason"]) &&
    value.kind === "codePreviewUnavailable" &&
    isPositiveSafeInteger(value.generation) &&
    (value.reason === "disposed" || value.reason === "sequenceExhausted")
  );
}

function hasValidHostState(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (
    !isPositiveSafeInteger((value as Record<string, unknown>).generation) ||
    !isNonNegativeSafeInteger((value as Record<string, unknown>).acknowledgedSequence) ||
    typeof (value as Record<string, unknown>).editable !== "boolean"
  ) {
    return false;
  }
  const identity = (value as Record<string, unknown>).runtimeIdentity;
  if (identity !== null && !isRuntimeIdentity(identity)) return false;
  return !(value as Record<string, unknown>).editable || (identity !== null && identity.codeDialect !== null);
}

function hasValidEditIdentity(value: Record<string, unknown>): boolean {
  return isPositiveSafeInteger(value.generation) && isPositiveSafeInteger(value.sequence);
}

function isCodePreviewInvalidReason(value: unknown): value is CodePreviewInvalidReason {
  return value === "codePoints" || value === "invalidUnicode" || value === "utf8Bytes";
}

function isCodePreviewRequestId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
