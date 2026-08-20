import { MAX_GENERATED_PYTHON_CODE_UTF8_BYTES } from "./protocolLimits.generated";

export const CODE_PREVIEW_MAX_UTF8_BYTES = MAX_GENERATED_PYTHON_CODE_UTF8_BYTES;
export const CODE_PREVIEW_MAX_CODE_POINTS = MAX_GENERATED_PYTHON_CODE_UTF8_BYTES;
export const CODE_PREVIEW_EDIT_COALESCE_MS = 100;

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
  "# Code Preview is unavailable because the buffer exceeds its Unicode or UTF-8 limit.";

export const CODE_PREVIEW_INVALID_EXPORT_MESSAGE =
  "The Code Preview buffer exceeds the 4 MiB or 4,194,304-code-point limit. Reduce it before copying or exporting generated code.";

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
