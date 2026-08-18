export const MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS = 4_096;
export const MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES = 16_384;
export const MAX_PORTABLE_REGEX_CAPTURE_GROUPS = 9;
export const MAX_PORTABLE_REGEX_REPEAT = 1_000;
export const MAX_PORTABLE_REGEX_TEXT_CODE_POINTS = 8_192;
export const MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES = 8_192;
export const MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES = 1_024;
export const PORTABLE_REGEX_TEXT_LIMIT_MESSAGE =
  "Regex extraction source values must contain at most 8,192 Unicode scalar values and 8,192 UTF-8 bytes.";

export interface PortableRegexContract {
  readonly captureCount: number;
  readonly participationPattern: string;
}

const ESCAPABLE_PATTERN_CHARACTERS = new Set([
  "\\",
  ".",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  "*",
  "+",
  "?",
  "|",
  "^",
  "$",
  "-"
]);

interface RegexAtom {
  readonly kind: "scalar" | "group";
  readonly group?: number;
  readonly empty: boolean;
  nullable: boolean;
  quantified: boolean;
  minimumWidth: number;
  minimumUtf8Bytes: number;
}

/**
 * Parses the deliberately small regular-expression language shared by every
 * editing backend. The subset is case-sensitive, Unicode-scalar based, and
 * excludes flags, alternation, anchors, lookarounds, backreferences, named or
 * nested groups, shorthand/property escapes, and quantified group bodies.
 */
export function portableRegexContract(pattern: string, group: number): PortableRegexContract {
  const codePoints = Array.from(pattern);
  if (
    codePoints.length === 0 ||
    codePoints.length > MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS ||
    !hasOnlyUnicodeScalars(pattern) ||
    pattern.includes("\0") ||
    pattern.includes("\r") ||
    pattern.includes("\n") ||
    new TextEncoder().encode(pattern).byteLength > MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES
  ) {
    throw new TypeError(
      `Regex extraction patterns must be single-line text containing 1 to ${MAX_PORTABLE_REGEX_PATTERN_CODE_POINTS.toLocaleString("en-US")} Unicode scalar values and at most ${MAX_PORTABLE_REGEX_PATTERN_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`
    );
  }
  if (!Number.isInteger(group) || group < 0 || group > MAX_PORTABLE_REGEX_CAPTURE_GROUPS) {
    throw new TypeError(`Regex extraction group must be an integer from 0 to ${MAX_PORTABLE_REGEX_CAPTURE_GROUPS}.`);
  }

  let captureCount = 0;
  let openGroup: { readonly group: number; readonly atoms: RegexAtom[] } | undefined;
  let previousAtom: RegexAtom | undefined;
  const optionalGroupMarkers = new Map<number, number>();
  let variableWidthQuantifiers = 0;
  let minimumRequiredWidth = 0;
  let minimumRequiredUtf8Bytes = 0;

  const recordAtom = (atom: RegexAtom) => {
    previousAtom = atom;
    if (openGroup) openGroup.atoms.push(atom);
    else {
      minimumRequiredWidth += atom.minimumWidth;
      minimumRequiredUtf8Bytes += atom.minimumUtf8Bytes;
    }
  };

  for (let index = 0; index < codePoints.length; index += 1) {
    const token = codePoints[index];
    if (token === "\\") {
      const escaped = codePoints[index + 1];
      if (escaped === undefined || !ESCAPABLE_PATTERN_CHARACTERS.has(escaped)) {
        throw new TypeError("Regex extraction permits escapes only for literal regular-expression punctuation.");
      }
      index += 1;
      recordAtom({
        kind: "scalar",
        empty: false,
        nullable: false,
        quantified: false,
        minimumWidth: 1,
        minimumUtf8Bytes: 1
      });
      continue;
    }
    if (token === "[") {
      const characterClass = consumePortableCharacterClass(codePoints, index);
      index = characterClass.end;
      recordAtom({
        kind: "scalar",
        empty: false,
        nullable: false,
        quantified: false,
        minimumWidth: 1,
        minimumUtf8Bytes: characterClass.minimumUtf8Bytes
      });
      continue;
    }
    if (token === "(") {
      if (openGroup) throw new TypeError("Regex extraction does not permit nested capture groups.");
      captureCount += 1;
      if (captureCount > MAX_PORTABLE_REGEX_CAPTURE_GROUPS) {
        throw new TypeError(`Regex extraction permits at most ${MAX_PORTABLE_REGEX_CAPTURE_GROUPS} capture groups.`);
      }
      openGroup = { group: captureCount, atoms: [] };
      previousAtom = undefined;
      continue;
    }
    if (token === ")") {
      if (!openGroup) throw new TypeError("Regex extraction contains an unmatched closing parenthesis.");
      const completed = openGroup;
      openGroup = undefined;
      previousAtom = {
        kind: "group",
        group: completed.group,
        empty: completed.atoms.length === 0,
        nullable: completed.atoms.every((atom) => atom.nullable),
        quantified: false,
        minimumWidth: completed.atoms.reduce((total, atom) => total + atom.minimumWidth, 0),
        minimumUtf8Bytes: completed.atoms.reduce((total, atom) => total + atom.minimumUtf8Bytes, 0)
      };
      minimumRequiredWidth += previousAtom.minimumWidth;
      minimumRequiredUtf8Bytes += previousAtom.minimumUtf8Bytes;
      continue;
    }
    if (token === "?" || token === "*" || token === "+" || token === "{") {
      if (!previousAtom || previousAtom.quantified) {
        throw new TypeError("Regex extraction quantifiers must follow exactly one unquantified atom.");
      }
      const quantifier =
        token === "{"
          ? consumePortableBoundedQuantifier(codePoints, index)
          : { end: index, minimum: token === "+" ? 1 : 0, variableWidth: true };
      if (previousAtom.kind === "group" && token !== "?") {
        throw new TypeError("Regex extraction capture groups may use only the optional ? quantifier.");
      }
      if (previousAtom.empty && token !== "?") {
        throw new TypeError("Regex extraction does not permit repeated empty atoms.");
      }
      if (previousAtom.kind === "group" && token === "?" && previousAtom.nullable) {
        throw new TypeError("Regex extraction optional capture groups must not match an empty string.");
      }
      if (quantifier.variableWidth) {
        variableWidthQuantifiers += 1;
        if (variableWidthQuantifiers > 1) {
          throw new TypeError("Regex extraction permits at most one variable-width quantifier per pattern.");
        }
      }
      const priorMinimumWidth = previousAtom.minimumWidth;
      const priorMinimumUtf8Bytes = previousAtom.minimumUtf8Bytes;
      previousAtom.quantified = true;
      previousAtom.nullable =
        token === "?" || token === "*" || (token === "{" && quantifier.minimum === 0) || previousAtom.nullable;
      previousAtom.minimumWidth = priorMinimumWidth * quantifier.minimum;
      previousAtom.minimumUtf8Bytes = priorMinimumUtf8Bytes * quantifier.minimum;
      if (!openGroup) {
        minimumRequiredWidth += previousAtom.minimumWidth - priorMinimumWidth;
        minimumRequiredUtf8Bytes += previousAtom.minimumUtf8Bytes - priorMinimumUtf8Bytes;
      }
      if (previousAtom.kind === "group" && previousAtom.group !== undefined) {
        optionalGroupMarkers.set(previousAtom.group, index);
      }
      index = quantifier.end;
      continue;
    }
    if (token === "]" || token === "}" || token === "|" || token === "^" || token === "$") {
      throw new TypeError(`Regex extraction does not permit unescaped ${JSON.stringify(token)}.`);
    }
    recordAtom({
      kind: "scalar",
      empty: false,
      nullable: false,
      quantified: false,
      minimumWidth: 1,
      minimumUtf8Bytes: new TextEncoder().encode(token).byteLength
    });
  }

  if (openGroup) throw new TypeError("Regex extraction contains an unclosed capture group.");
  if (
    minimumRequiredWidth > MAX_PORTABLE_REGEX_TEXT_CODE_POINTS ||
    minimumRequiredUtf8Bytes > MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES
  ) {
    throw new TypeError(
      `Regex extraction minimum match width must not exceed ${MAX_PORTABLE_REGEX_TEXT_CODE_POINTS.toLocaleString("en-US")} Unicode scalar values or ${MAX_PORTABLE_REGEX_TEXT_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`
    );
  }
  if (group > captureCount) {
    throw new TypeError(`Regex extraction group ${group} does not exist; the pattern defines ${captureCount}.`);
  }
  const optionalMarker = optionalGroupMarkers.get(group);
  return {
    captureCount,
    participationPattern:
      group === 0 || optionalMarker === undefined
        ? pattern
        : codePoints.filter((_token, index) => index !== optionalMarker).join("")
  };
}

export function validatePortableRegexOutputName(value: string): void {
  if (
    value.length === 0 ||
    !hasOnlyUnicodeScalars(value) ||
    value.includes("\0") ||
    value.includes("\r") ||
    value.includes("\n") ||
    new TextEncoder().encode(value).byteLength > MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES
  ) {
    throw new TypeError(
      `Regex extraction output names must be non-empty single-line Unicode scalar text of at most ${MAX_PORTABLE_REGEX_OUTPUT_NAME_UTF8_BYTES.toLocaleString("en-US")} UTF-8 bytes.`
    );
  }
}

function consumePortableCharacterClass(
  codePoints: readonly string[],
  start: number
): { readonly end: number; readonly minimumUtf8Bytes: number } {
  let index = start + 1;
  const negated = codePoints[index] === "^";
  if (negated) index += 1;
  let members = 0;
  let minimumUtf8Bytes = negated ? 1 : Number.POSITIVE_INFINITY;
  let previousRangeEndpoint: string | undefined;
  for (; index < codePoints.length; index += 1) {
    let token = codePoints[index];
    let escaped = false;
    if (token === "]") {
      if (members === 0) throw new TypeError("Regex extraction character classes must not be empty.");
      return { end: index, minimumUtf8Bytes };
    }
    if (token === "\\") {
      token = codePoints[index + 1];
      if (token === undefined || !new Set(["\\", "]", "-"]).has(token)) {
        throw new TypeError("Regex extraction character classes permit escapes only for \\, ], and -.");
      }
      index += 1;
      escaped = true;
    }
    if (
      token === "[" ||
      (token === "&" && codePoints[index + 1] === "&") ||
      (token === "~" && codePoints[index + 1] === "~") ||
      (token === "|" && codePoints[index + 1] === "|")
    ) {
      throw new TypeError("Regex extraction character classes do not permit dialect-specific set operators.");
    }
    if (token === "-" && !escaped) {
      const endpoint = codePoints[index + 1];
      if (previousRangeEndpoint === undefined || endpoint === undefined || endpoint === "]" || endpoint === "\\") {
        throw new TypeError("Regex extraction character-class ranges require two literal endpoints.");
      }
      if (
        !isAscii(previousRangeEndpoint) ||
        !isAscii(endpoint) ||
        previousRangeEndpoint.codePointAt(0)! > endpoint.codePointAt(0)!
      ) {
        throw new TypeError("Regex extraction character-class ranges must use ascending ASCII endpoints.");
      }
      members += 1;
      minimumUtf8Bytes = 1;
      previousRangeEndpoint = endpoint;
      index += 1;
      continue;
    }
    members += 1;
    minimumUtf8Bytes = Math.min(minimumUtf8Bytes, new TextEncoder().encode(token).byteLength);
    previousRangeEndpoint = token;
  }
  throw new TypeError("Regex extraction contains an unclosed character class.");
}

function consumePortableBoundedQuantifier(
  codePoints: readonly string[],
  start: number
): { readonly end: number; readonly minimum: number; readonly variableWidth: boolean } {
  const close = codePoints.indexOf("}", start + 1);
  if (close < 0) throw new TypeError("Regex extraction contains an unclosed bounded quantifier.");
  const body = codePoints.slice(start + 1, close).join("");
  const match = /^(0|[1-9][0-9]*)(?:,(0|[1-9][0-9]*))?$/u.exec(body);
  if (!match) throw new TypeError("Regex extraction bounded quantifiers must use {count} or {minimum,maximum}.");
  const minimum = Number(match[1]);
  const maximum = Number(match[2] ?? match[1]);
  if (minimum > maximum || maximum > MAX_PORTABLE_REGEX_REPEAT) {
    throw new TypeError(
      `Regex extraction bounded quantifiers require 0 <= minimum <= maximum <= ${MAX_PORTABLE_REGEX_REPEAT}.`
    );
  }
  return { end: close, minimum, variableWidth: minimum !== maximum };
}

function isAscii(value: string): boolean {
  return (value.codePointAt(0) ?? 128) < 128;
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
