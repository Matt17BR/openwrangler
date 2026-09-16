const MAX_EVALUATION_CODE_BYTES = 1_024 * 1_024;

export function assertREvaluationCode(code: string): void {
  if (typeof code !== "string" || code.length === 0 || Buffer.byteLength(code, "utf8") > MAX_EVALUATION_CODE_BYTES) {
    throw new TypeError("The R code chunk must contain between 1 byte and 1 MiB of UTF-8 text.");
  }
}

/** Returns a self-contained R expression without mixed escaped/literal Unicode. */
export function rStringExpression(value: string): string {
  if (value.includes("\0") || /[\uD800-\uDFFF]/u.test(value)) {
    throw new TypeError("R code strings must contain valid Unicode without NUL.");
  }
  const literal = JSON.stringify(value);
  // Paired backslashes encode literal text, not R Unicode escapes.
  if (!/\\[uU]/u.test(literal.replaceAll("\\\\", ""))) return literal;
  // R's Unicode-escaped literal parser corrupts supplementary characters on Windows and has a 10,000-character cap.
  const points = Array.from(value, (character) => character.codePointAt(0)!);
  return `base::intToUtf8(base::c(${points.join(", ")}))`;
}
