import type { FormulaLiteral } from "./protocol.generated";
import { MAX_FORMULA_INPUT_CHARACTERS, MAX_FORMULA_INTEGER_DIGITS } from "./protocolLimits.generated";

const canonicalInteger = /^(?:0|-?[1-9][0-9]*)(?![\s\S])/u;
const enteredInteger = /^[+-]?[0-9]+(?![\s\S])/u;

export function isFormulaLiteral(value: unknown): value is FormulaLiteral {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string" || value.length > MAX_FORMULA_INTEGER_DIGITS + 1) return false;
  const digits = value.startsWith("-") ? value.length - 1 : value.length;
  return digits <= MAX_FORMULA_INTEGER_DIGITS && canonicalInteger.test(value) && Number.isFinite(Number(value));
}

export function parseFormulaLiteral(raw: string): FormulaLiteral {
  // Bound pasted text before numeric conversion, including redundant leading zeros.
  if (raw.length > MAX_FORMULA_INPUT_CHARACTERS) {
    throw new Error(`Formula input must contain at most ${MAX_FORMULA_INPUT_CHARACTERS} characters.`);
  }
  const text = raw.trim();
  const numeric = Number(text);
  if (text === "" || !Number.isFinite(numeric)) {
    throw new Error("Formula requires one finite numeric value or a right column.");
  }
  if (enteredInteger.test(text)) {
    const digits = text.replace(/^[+-]?0*/u, "") || "0";
    const canonical = text.startsWith("-") && digits !== "0" ? `-${digits}` : digits;
    if (!isFormulaLiteral(canonical)) {
      throw new Error(`Formula integers must contain at most ${MAX_FORMULA_INTEGER_DIGITS} digits and remain finite.`);
    }
    return Number.isSafeInteger(numeric) ? Number(canonical) : canonical;
  }
  // Preserve the existing binary64 interpretation and JSON integer/scientific class.
  return hasUnsafePlainIntegerValue(numeric) ? BigInt(numeric).toString() : numeric;
}

export function formatFormulaLiteral(value: FormulaLiteral): string {
  return typeof value === "number" && hasUnsafePlainIntegerValue(value) ? BigInt(value).toString() : String(value);
}

function hasUnsafePlainIntegerValue(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value) && Math.abs(value) < 1e21;
}
