import { MAX_GENERATED_PYTHON_CODE_UTF8_BYTES } from "./protocolLimits.generated";

export const CODE_PREVIEW_MAX_UTF8_BYTES = MAX_GENERATED_PYTHON_CODE_UTF8_BYTES;
export const CODE_PREVIEW_MAX_CODE_POINTS = MAX_GENERATED_PYTHON_CODE_UTF8_BYTES;
export const CODE_PREVIEW_EDIT_COALESCE_MS = 100;
export const CODE_PREVIEW_SNAPSHOT_TIMEOUT_MS = 500;
export const CODE_PREVIEW_HISTORY_MAX_LOCAL_EDITS = 100;
export const CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES = CODE_PREVIEW_MAX_UTF8_BYTES * 4;
export const CODE_PREVIEW_HISTORY_MAX_VALID_EDIT_TRANSIENT_UTF8_BYTES =
  CODE_PREVIEW_HISTORY_MAX_RETAINED_UTF8_BYTES + CODE_PREVIEW_MAX_UTF8_BYTES * 2;

export type CodePreviewInvalidReason = "codePoints" | "invalidUnicode" | "utf8Bytes";

export type CodePreviewTextResult =
  | {
      readonly valid: true;
      readonly code: string;
      readonly codePoints: number;
      readonly utf8Bytes: number;
    }
  | { readonly valid: false; readonly reason: CodePreviewInvalidReason };

export const CODE_PREVIEW_INVALID_PLACEHOLDER =
  "# Code Preview is unavailable because the buffer contains malformed Unicode or exceeds its Unicode or UTF-8 limit.";

export const CODE_PREVIEW_INVALID_EXPORT_MESSAGE =
  "The Code Preview buffer contains malformed Unicode or exceeds the 4 MiB or 4,194,304-code-point limit. Correct or reduce it before copying, exporting, or inserting generated code.";

export const CODE_PREVIEW_UNAVAILABLE_PLACEHOLDER =
  "# Code Preview is unavailable because the current editor state could not be confirmed.";

export const CODE_PREVIEW_DISPOSED_ACTION_MESSAGE =
  "Code Preview is not available. Reopen the view before copying, exporting, or inserting generated code.";

export const CODE_PREVIEW_MISMATCH_ACTION_MESSAGE =
  "Code Preview changed before the current edit could be confirmed. Review it and try again.";

export const CODE_PREVIEW_TIMEOUT_ACTION_MESSAGE =
  "Code Preview did not confirm the current edit in time. Reopen the view and try again.";

export const CODE_PREVIEW_POST_FAILED_ACTION_MESSAGE =
  "Code Preview could not request the current edit. Reopen the view and try again.";

export const CODE_PREVIEW_GENERATION_EXHAUSTED_ACTION_MESSAGE =
  "Code Preview exhausted its edit generation. Reopen the view before using generated code.";

export const CODE_PREVIEW_EMPTY_ACTION_MESSAGE =
  "Code Preview is empty. Add generated code before copying, exporting, or inserting it.";

export function validateCodePreviewText(code: string): CodePreviewTextResult {
  return collectCodePreviewText([code]);
}

export function collectCodePreviewText(chunks: Iterable<string>): CodePreviewTextResult {
  const accepted: string[] = [];
  let codePoints = 0;
  let utf8Bytes = 0;
  let pendingHighSurrogate = false;

  for (const chunk of chunks) {
    accepted.push(chunk);
    for (let index = 0; index < chunk.length; index += 1) {
      const unit = chunk.charCodeAt(index);
      if (pendingHighSurrogate) {
        if (!isLowSurrogate(unit)) return { valid: false, reason: "invalidUnicode" };
        pendingHighSurrogate = false;
        codePoints += 1;
        utf8Bytes += 4;
      } else if (isHighSurrogate(unit)) {
        pendingHighSurrogate = true;
        continue;
      } else if (isLowSurrogate(unit)) {
        return { valid: false, reason: "invalidUnicode" };
      } else {
        codePoints += 1;
        utf8Bytes += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 : 3;
      }
      if (codePoints > CODE_PREVIEW_MAX_CODE_POINTS) return { valid: false, reason: "codePoints" };
      if (utf8Bytes > CODE_PREVIEW_MAX_UTF8_BYTES) return { valid: false, reason: "utf8Bytes" };
    }
  }

  if (pendingHighSurrogate) return { valid: false, reason: "invalidUnicode" };
  return { valid: true, code: accepted.join(""), codePoints, utf8Bytes };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
