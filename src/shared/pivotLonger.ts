export const MIN_PIVOT_LONGER_COLUMNS = 2;
export const MAX_PIVOT_LONGER_COLUMNS = 64;
export const MAX_PIVOT_LONGER_OUTPUT_NAME_UTF8_BYTES = 1_024;

/** Locale-independent output-name collision key shared by every runtime. */
export function portablePivotLongerNameKey(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0x41 && codePoint <= 0x5a) {
      return String.fromCodePoint(codePoint + 0x20);
    }
    // Keep the one common multi-scalar fold explicit without inheriting a
    // host locale or a backend-specific Unicode table.
    return character === "ß" || character === "ẞ" ? "ss" : character;
  }).join("");
}

export function validatePivotLongerOutputName(value: string, label: string): void {
  if (
    value.length === 0 ||
    !hasOnlyUnicodeScalars(value) ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    new TextEncoder().encode(value).byteLength > MAX_PIVOT_LONGER_OUTPUT_NAME_UTF8_BYTES
  ) {
    throw new TypeError(
      `${label} must be non-empty single-line Unicode scalar text of at most ` +
        `${MAX_PIVOT_LONGER_OUTPUT_NAME_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`
    );
  }
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
