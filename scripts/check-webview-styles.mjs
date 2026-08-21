import { constants as fileSystemConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const WEBVIEW_STYLE_IMPORTS = [
  "foundations.css",
  "application.css",
  "column-search.css",
  "workspace.css",
  "filters.css",
  "grid.css",
  "grid-insights.css",
  "summary.css",
  "operations.css",
  "responsive.css"
];

export const WEBVIEW_STYLE_LIMITS = Object.freeze({
  selectorOccurrences: 2_048,
  selectorRules: 4_096,
  selectorCodeUnits: 8_192,
  classNameCodePoints: 256,
  classReferenceTokens: 16_384,
  cssTokens: 100_000,
  nestingDepth: 32,
  totalWork: 2 * 1024 * 1024
});

const REMOVED_SELECTORS = new Set(["columnSearchCount", "miniBar"]);
const MAX_ENTRY_BYTES = 4 * 1024;
const MAX_FOUNDATION_LINES = 100;
const MAX_OWNED_STYLESHEET_LINES = 700;
const MAX_STYLE_BYTES = 1024 * 1024;
const MAX_STYLE_FILE_BYTES = 128 * 1024;
const MAX_WEBVIEW_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_WEBVIEW_SOURCE_FILE_BYTES = 512 * 1024;
const MAX_WEBVIEW_SOURCE_FILES = 128;
const GROUP_RULE_AT_KEYWORDS = new Set([
  "container",
  "document",
  "layer",
  "media",
  "scope",
  "starting-style",
  "supports"
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFileSystem = Object.freeze({ lstat, open, readdir });
const directoryOpenFlags =
  fileSystemConstants.O_RDONLY |
  (fileSystemConstants.O_DIRECTORY ?? 0) |
  (fileSystemConstants.O_NOFOLLOW ?? 0) |
  (fileSystemConstants.O_NONBLOCK ?? 0) |
  (fileSystemConstants.O_CLOEXEC ?? 0);
const fileOpenFlags =
  fileSystemConstants.O_RDONLY |
  (fileSystemConstants.O_NOFOLLOW ?? 0) |
  (fileSystemConstants.O_NONBLOCK ?? 0) |
  (fileSystemConstants.O_CLOEXEC ?? 0);
const cssWhitespacePattern = /[\t\n\f\r ]/u;

function lineCount(source) {
  return source === "" ? 0 : source.replace(/\n$/u, "").split("\n").length;
}

function operationsFor(options) {
  return Object.freeze({ ...defaultFileSystem, ...(options.filesystem ?? {}) });
}

function containedRelativePath(root, target, label) {
  const result = relative(root, target);
  if (result === "" || isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) {
    throw new Error(`${label} must be a contained descendant of the repository root.`);
  }
  return result;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.nlink === right.nlink;
}

function sameStableNode(left, right) {
  return (
    sameNode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDirectory(metadata, label) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symbolic link.`);
  }
}

async function closeHandles(handles, primaryFailure) {
  const failures = [];
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (primaryFailure !== undefined) {
    if (failures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...failures],
        "A bounded webview read failed and its descriptors did not all close."
      );
    }
    throw primaryFailure;
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Bounded webview read descriptors did not all close.");
  }
}

async function withStableDirectoryChain(root, targetDirectory, filesystem, label, callback) {
  const rootPath = resolve(root);
  const targetPath = resolve(targetDirectory);
  const relativeTarget = targetPath === rootPath ? "" : containedRelativePath(rootPath, targetPath, label);
  const components = relativeTarget === "" ? [] : relativeTarget.split(sep);
  const paths = [rootPath];
  for (let index = 0; index < components.length; index += 1) {
    paths.push(resolve(rootPath, ...components.slice(0, index + 1)));
  }

  const opened = [];
  let result;
  let failure;
  try {
    for (const path of paths) {
      const named = await filesystem.lstat(path, { bigint: true });
      assertDirectory(named, relative(rootPath, path) || "repository root");
      const handle = await filesystem.open(path, directoryOpenFlags);
      opened.push({ handle, named, path });
      const descriptor = await handle.stat({ bigint: true });
      assertDirectory(descriptor, relative(rootPath, path) || "repository root");
      if (!sameStableNode(named, descriptor)) {
        throw new Error(`${label} ancestor changed while its no-follow descriptor was opened.`);
      }
    }

    result = await callback();

    for (const { handle, named, path } of opened) {
      const descriptor = await handle.stat({ bigint: true });
      const current = await filesystem.lstat(path, { bigint: true });
      if (!sameStableNode(named, descriptor) || !sameStableNode(named, current)) {
        throw new Error(`${label} ancestor changed while its descriptor-bound operation ran.`);
      }
    }
  } catch (error) {
    failure = error;
  }
  await closeHandles(
    opened.map(({ handle }) => handle),
    failure
  );
  return result;
}

async function readStableDirectory(root, path, filesystem, label) {
  return withStableDirectoryChain(root, path, filesystem, label, () =>
    filesystem.readdir(path, { withFileTypes: true })
  );
}

async function readDescriptorBytes(handle, expectedSize, label) {
  const size = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(size + 1);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const trailing = await handle.read(bytes, size, 1, size);
  if (offset !== size || trailing.bytesRead !== 0) {
    throw new Error(`${label} changed length while its bounded descriptor snapshot was read.`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size));
  } catch {
    throw new Error(`${label} must contain valid UTF-8.`);
  }
}

async function readBoundedFile(root, path, maxBytes, label, filesystem) {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  containedRelativePath(absoluteRoot, absolutePath, label);
  return withStableDirectoryChain(absoluteRoot, dirname(absolutePath), filesystem, label, async () => {
    const namedBefore = await filesystem.lstat(absolutePath, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.size > BigInt(maxBytes)) {
      throw new Error(`${label} must be a no-follow regular file no larger than ${maxBytes} bytes.`);
    }
    let handle;
    let result;
    let failure;
    try {
      handle = await filesystem.open(absolutePath, fileOpenFlags);
      const descriptorBefore = await handle.stat({ bigint: true });
      if (!descriptorBefore.isFile() || !sameStableNode(namedBefore, descriptorBefore)) {
        throw new Error(`${label} changed while its no-follow descriptor was opened.`);
      }
      result = await readDescriptorBytes(handle, descriptorBefore.size, label);
      const descriptorAfter = await handle.stat({ bigint: true });
      const namedAfter = await filesystem.lstat(absolutePath, { bigint: true });
      if (!sameStableNode(descriptorBefore, descriptorAfter) || !sameStableNode(descriptorBefore, namedAfter)) {
        throw new Error(`${label} changed while its descriptor-bound snapshot was read.`);
      }
    } catch (error) {
      failure = error;
    }
    await closeHandles(handle === undefined ? [] : [handle], failure);
    return result;
  });
}

class WorkBudget {
  constructor() {
    this.used = 0;
  }

  consume(amount, label) {
    this.used += amount;
    if (this.used > WEBVIEW_STYLE_LIMITS.totalWork) {
      throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.totalWork}-unit total-work budget.`);
    }
  }
}

function isCssWhitespace(value) {
  return value !== undefined && cssWhitespacePattern.test(value);
}

function isHexDigit(value) {
  return value !== undefined && /[0-9A-Fa-f]/u.test(value);
}

function codePointLengthAt(source, index) {
  return (source.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
}

function isCssNameStart(source, index) {
  const point = source.codePointAt(index);
  return (
    point !== undefined &&
    ((point >= 0x41 && point <= 0x5a) || (point >= 0x61 && point <= 0x7a) || point === 0x5f || point >= 0x80)
  );
}

function isValidCssEscape(source, index) {
  return source[index] === "\\" && source[index + 1] !== undefined && !/[\n\r\f]/u.test(source[index + 1]);
}

function wouldStartCssIdentifier(source, index) {
  if (isCssNameStart(source, index) || isValidCssEscape(source, index)) return true;
  if (source[index] !== "-") return false;
  return source[index + 1] === "-" || isCssNameStart(source, index + 1) || isValidCssEscape(source, index + 1);
}

function consumeCssEscape(source, index) {
  let cursor = index + 1;
  if (!isValidCssEscape(source, index)) {
    throw new Error("CSS contains an invalid escape sequence.");
  }
  if (isHexDigit(source[cursor])) {
    const start = cursor;
    while (cursor - start < 6 && isHexDigit(source[cursor])) cursor += 1;
    const point = Number.parseInt(source.slice(start, cursor), 16);
    if (isCssWhitespace(source[cursor])) {
      if (source[cursor] === "\r" && source[cursor + 1] === "\n") cursor += 2;
      else cursor += 1;
    }
    const normalized = point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? 0xfffd : point;
    return { cursor, value: String.fromCodePoint(normalized) };
  }
  const length = codePointLengthAt(source, cursor);
  return { cursor: cursor + length, value: source.slice(cursor, cursor + length) };
}

function consumeCssName(source, index) {
  let cursor = index;
  let value = "";
  while (cursor < source.length) {
    const point = source.codePointAt(cursor);
    if (
      point !== undefined &&
      ((point >= 0x41 && point <= 0x5a) ||
        (point >= 0x61 && point <= 0x7a) ||
        (point >= 0x30 && point <= 0x39) ||
        point === 0x2d ||
        point === 0x5f ||
        point >= 0x80)
    ) {
      const length = point > 0xffff ? 2 : 1;
      value += source.slice(cursor, cursor + length);
      cursor += length;
      continue;
    }
    if (isValidCssEscape(source, cursor)) {
      const escaped = consumeCssEscape(source, cursor);
      value += escaped.value;
      cursor = escaped.cursor;
      continue;
    }
    break;
  }
  return { cursor, value };
}

function consumeCssString(source, index, quote, label) {
  let cursor = index + 1;
  let value = "";
  while (cursor < source.length) {
    if (source[cursor] === quote) return { cursor: cursor + 1, value };
    if (/[\n\r\f]/u.test(source[cursor])) throw new Error(`${label} contains an unterminated CSS string.`);
    if (source[cursor] === "\\") {
      if (source[cursor + 1] === "\n" || source[cursor + 1] === "\f") {
        cursor += 2;
        continue;
      }
      if (source[cursor + 1] === "\r") {
        cursor += source[cursor + 2] === "\n" ? 3 : 2;
        continue;
      }
      const escaped = consumeCssEscape(source, cursor);
      value += escaped.value;
      cursor = escaped.cursor;
      continue;
    }
    const length = codePointLengthAt(source, cursor);
    value += source.slice(cursor, cursor + length);
    cursor += length;
  }
  throw new Error(`${label} contains an unterminated CSS string.`);
}

function tokenizeCss(source, label, budget) {
  budget.consume(source.length, label);
  const tokens = [];
  let cursor = 0;
  const append = (token) => {
    tokens.push(token);
    budget.consume(1, label);
    if (tokens.length > WEBVIEW_STYLE_LIMITS.cssTokens) {
      throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.cssTokens}-token CSS budget.`);
    }
  };
  while (cursor < source.length) {
    const start = cursor;
    if (isCssWhitespace(source[cursor]) || (source[cursor] === "/" && source[cursor + 1] === "*")) {
      while (cursor < source.length) {
        if (isCssWhitespace(source[cursor])) {
          cursor += source[cursor] === "\r" && source[cursor + 1] === "\n" ? 2 : 1;
          continue;
        }
        if (source[cursor] === "/" && source[cursor + 1] === "*") {
          const close = source.indexOf("*/", cursor + 2);
          if (close === -1) throw new Error(`${label} contains an unterminated CSS comment.`);
          cursor = close + 2;
          continue;
        }
        break;
      }
      append({ end: cursor, kind: "whitespace", start });
      continue;
    }
    if (source[cursor] === '"' || source[cursor] === "'") {
      const string = consumeCssString(source, cursor, source[cursor], label);
      cursor = string.cursor;
      append({ end: cursor, kind: "string", start, value: string.value });
      continue;
    }
    if (source[cursor] === "@" && wouldStartCssIdentifier(source, cursor + 1)) {
      const name = consumeCssName(source, cursor + 1);
      cursor = name.cursor;
      append({ end: cursor, kind: "at-keyword", start, value: name.value });
      continue;
    }
    if (wouldStartCssIdentifier(source, cursor)) {
      const name = consumeCssName(source, cursor);
      cursor = name.cursor;
      append({ end: cursor, kind: "ident", start, value: name.value });
      continue;
    }
    const length = codePointLengthAt(source, cursor);
    cursor += length;
    append({ end: cursor, kind: "delimiter", start, value: source.slice(start, cursor) });
  }
  return tokens;
}

function skipWhitespace(tokens, index, end, state, label) {
  let cursor = index;
  while (cursor < end && tokens[cursor].kind === "whitespace") {
    state?.budget.consume(1, label);
    cursor += 1;
  }
  return cursor;
}

function assertNestingDepth(depth, label) {
  if (depth > WEBVIEW_STYLE_LIMITS.nestingDepth) {
    throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.nestingDepth}-level CSS nesting limit.`);
  }
}

function findBlockEnd(tokens, openIndex, end, label, state) {
  let depth = 1;
  for (let cursor = openIndex + 1; cursor < end; cursor += 1) {
    state.budget.consume(1, label);
    if (tokens[cursor].kind !== "delimiter") continue;
    if (tokens[cursor].value === "{") depth += 1;
    if (tokens[cursor].value === "}") depth -= 1;
    if (depth === 0) return cursor;
  }
  throw new Error(`${label} contains an unterminated CSS block.`);
}

function scanPreludeBoundary(tokens, index, end, label, state) {
  let parentheses = 0;
  let brackets = 0;
  for (let cursor = index; cursor < end; cursor += 1) {
    state.budget.consume(1, label);
    const token = tokens[cursor];
    if (token.kind !== "delimiter") continue;
    if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    if (parentheses < 0 || brackets < 0) throw new Error(`${label} contains unbalanced CSS grammar.`);
    if (parentheses === 0 && brackets === 0 && [";", "{", "}"].includes(token.value)) {
      return { boundary: token.value, index: cursor };
    }
  }
  throw new Error(`${label} contains an unterminated CSS rule.`);
}

function importTarget(tokens, start, end, label, state) {
  const first = skipWhitespace(tokens, start, end, state, label);
  if (first >= end || tokens[first].kind !== "string") {
    throw new Error(`${label} imports must use one bounded quoted path.`);
  }
  if (skipWhitespace(tokens, first + 1, end, state, label) !== end) {
    throw new Error(`${label} imports must not carry media, layer, support, or other qualifiers.`);
  }
  if (Buffer.byteLength(tokens[first].value, "utf8") > MAX_ENTRY_BYTES) {
    throw new Error(`${label} contains an oversized import path.`);
  }
  return tokens[first].value;
}

function addSelectorClasses(tokens, start, end, label, state) {
  const first = skipWhitespace(tokens, start, end, state, label);
  const last = (() => {
    let cursor = end;
    while (cursor > first && tokens[cursor - 1].kind === "whitespace") {
      state.budget.consume(1, label);
      cursor -= 1;
    }
    return cursor;
  })();
  if (first >= last) throw new Error(`${label} contains an empty qualified rule.`);
  const selectorLength = tokens[last - 1].end - tokens[first].start;
  if (selectorLength > WEBVIEW_STYLE_LIMITS.selectorCodeUnits) {
    throw new Error(
      `${label} contains a selector prelude above the ${WEBVIEW_STYLE_LIMITS.selectorCodeUnits}-code-unit limit.`
    );
  }
  state.selectorRules += 1;
  if (state.selectorRules > WEBVIEW_STYLE_LIMITS.selectorRules) {
    throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.selectorRules}-rule selector budget.`);
  }
  let brackets = 0;
  for (let cursor = first; cursor < last; cursor += 1) {
    state.budget.consume(1, label);
    const token = tokens[cursor];
    if (token.kind === "delimiter" && token.value === "[") {
      brackets += 1;
      continue;
    }
    if (token.kind === "delimiter" && token.value === "]") {
      brackets = Math.max(0, brackets - 1);
      continue;
    }
    if (brackets === 0 && token.kind === "delimiter" && token.value === "." && tokens[cursor + 1]?.kind === "ident") {
      const className = tokens[cursor + 1].value;
      if ([...className].length > WEBVIEW_STYLE_LIMITS.classNameCodePoints) {
        throw new Error(
          `${label} contains a class selector above the ${WEBVIEW_STYLE_LIMITS.classNameCodePoints}-code-point limit.`
        );
      }
      state.selectorOccurrences += 1;
      if (state.selectorOccurrences > WEBVIEW_STYLE_LIMITS.selectorOccurrences) {
        throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.selectorOccurrences}-class-selector budget.`);
      }
      state.classes.add(className);
    }
  }
}

function parseCssRuleList(tokens, start, end, label, state, depth) {
  assertNestingDepth(depth, label);
  let cursor = start;
  while ((cursor = skipWhitespace(tokens, cursor, end, state, label)) < end) {
    const token = tokens[cursor];
    if (token.kind === "delimiter" && token.value === ";") {
      cursor += 1;
      continue;
    }
    if (token.kind === "delimiter" && token.value === "}") {
      throw new Error(`${label} contains an unmatched CSS block terminator.`);
    }
    state.budget.consume(1, label);
    if (token.kind === "at-keyword") {
      const name = token.value.toLocaleLowerCase("en-US");
      const boundary = scanPreludeBoundary(tokens, cursor + 1, end, label, state);
      if (name === "import") {
        if (boundary.boundary !== ";") throw new Error(`${label} contains a malformed @import rule.`);
        state.imports.push({ depth, target: importTarget(tokens, cursor + 1, boundary.index, label, state) });
        cursor = boundary.index + 1;
        continue;
      }
      state.nonImportRules += 1;
      if (boundary.boundary === "}") throw new Error(`${label} contains an unterminated at-rule.`);
      if (boundary.boundary === ";") {
        cursor = boundary.index + 1;
        continue;
      }
      if (name === "scope" && skipWhitespace(tokens, cursor + 1, boundary.index, state, label) < boundary.index) {
        addSelectorClasses(tokens, cursor + 1, boundary.index, label, state);
      }
      const close = findBlockEnd(tokens, boundary.index, end, label, state);
      if (GROUP_RULE_AT_KEYWORDS.has(name)) {
        parseCssRuleList(tokens, boundary.index + 1, close, label, state, depth + 1);
      }
      cursor = close + 1;
      continue;
    }

    const boundary = scanPreludeBoundary(tokens, cursor, end, label, state);
    if (boundary.boundary !== "{") throw new Error(`${label} contains a qualified rule without a block.`);
    state.nonImportRules += 1;
    addSelectorClasses(tokens, cursor, boundary.index, label, state);
    const close = findBlockEnd(tokens, boundary.index, end, label, state);
    parseCssStyleBlock(tokens, boundary.index + 1, close, label, state, depth + 1);
    cursor = close + 1;
  }
}

function skipDeclarationValue(tokens, start, end, label, state) {
  let parentheses = 0;
  let brackets = 0;
  let blocks = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    state.budget.consume(1, label);
    const token = tokens[cursor];
    if (token.kind !== "delimiter") continue;
    if (token.value === "(") parentheses += 1;
    else if (token.value === ")") parentheses -= 1;
    else if (token.value === "[") brackets += 1;
    else if (token.value === "]") brackets -= 1;
    else if (token.value === "{") blocks += 1;
    else if (token.value === "}") blocks -= 1;
    if (parentheses < 0 || brackets < 0 || blocks < 0) {
      throw new Error(`${label} contains unbalanced CSS declaration grammar.`);
    }
    if (parentheses === 0 && brackets === 0 && blocks === 0 && token.value === ";") return cursor + 1;
  }
  if (parentheses !== 0 || brackets !== 0 || blocks !== 0) {
    throw new Error(`${label} contains an unterminated CSS declaration value.`);
  }
  return end;
}

function parseCssStyleBlock(tokens, start, end, label, state, depth) {
  assertNestingDepth(depth, label);
  let cursor = start;
  while ((cursor = skipWhitespace(tokens, cursor, end, state, label)) < end) {
    const token = tokens[cursor];
    state.budget.consume(1, label);
    if (token.kind === "delimiter" && token.value === ";") {
      cursor += 1;
      continue;
    }
    if (token.kind === "at-keyword") {
      const name = token.value.toLocaleLowerCase("en-US");
      const boundary = scanPreludeBoundary(tokens, cursor + 1, end, label, state);
      if (name === "import") {
        if (boundary.boundary !== ";") throw new Error(`${label} contains a malformed nested @import rule.`);
        state.imports.push({ depth, target: importTarget(tokens, cursor + 1, boundary.index, label, state) });
        cursor = boundary.index + 1;
        continue;
      }
      state.nonImportRules += 1;
      if (boundary.boundary !== "{") {
        if (boundary.boundary === ";") {
          cursor = boundary.index + 1;
          continue;
        }
        throw new Error(`${label} contains an unterminated nested at-rule.`);
      }
      if (name === "scope" && skipWhitespace(tokens, cursor + 1, boundary.index, state, label) < boundary.index) {
        addSelectorClasses(tokens, cursor + 1, boundary.index, label, state);
      }
      const close = findBlockEnd(tokens, boundary.index, end, label, state);
      if (GROUP_RULE_AT_KEYWORDS.has(name)) {
        parseCssStyleBlock(tokens, boundary.index + 1, close, label, state, depth + 1);
      }
      cursor = close + 1;
      continue;
    }
    if (token.kind === "ident") {
      const colon = skipWhitespace(tokens, cursor + 1, end, state, label);
      if (tokens[colon]?.kind !== "delimiter" || tokens[colon].value !== ":") {
        throw new Error(`${label} nested type selectors must use an explicit & prefix.`);
      }
      cursor = skipDeclarationValue(tokens, colon + 1, end, label, state);
      continue;
    }

    const boundary = scanPreludeBoundary(tokens, cursor, end, label, state);
    if (boundary.boundary !== "{") {
      throw new Error(`${label} contains a nested selector without a block.`);
    }
    state.nonImportRules += 1;
    addSelectorClasses(tokens, cursor, boundary.index, label, state);
    const close = findBlockEnd(tokens, boundary.index, end, label, state);
    parseCssStyleBlock(tokens, boundary.index + 1, close, label, state, depth + 1);
    cursor = close + 1;
  }
}

function parseCss(source, label, budget) {
  const tokens = tokenizeCss(source, label, budget);
  const state = {
    budget,
    classes: new Set(),
    imports: [],
    nonImportRules: 0,
    selectorOccurrences: 0,
    selectorRules: 0
  };
  parseCssRuleList(tokens, 0, tokens.length, label, state, 0);
  return state;
}

function stringStartsWithWhitespace(value) {
  return value === "" || isCssWhitespace(value[0]);
}

function stringEndsWithWhitespace(value) {
  return value === "" || isCssWhitespace(value.at(-1));
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function expressionHasBoundary(expression, side) {
  const current = unwrapExpression(expression);
  if (ts.isStringLiteralLike(current)) {
    return side === "start" ? stringStartsWithWhitespace(current.text) : stringEndsWithWhitespace(current.text);
  }
  if (ts.isConditionalExpression(current)) {
    return expressionHasBoundary(current.whenTrue, side) && expressionHasBoundary(current.whenFalse, side);
  }
  if (current.kind === ts.SyntaxKind.NullKeyword || current.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return false;
}

function addStaticClassText(value, boundaries, state, label) {
  let cursor = 0;
  while (cursor < value.length) {
    while (cursor < value.length && isCssWhitespace(value[cursor])) cursor += 1;
    const start = cursor;
    while (cursor < value.length && !isCssWhitespace(value[cursor])) cursor += codePointLengthAt(value, cursor);
    if (start === cursor) continue;
    const leftBounded = start > 0 || boundaries.left;
    const rightBounded = cursor < value.length || boundaries.right;
    if (!leftBounded || !rightBounded) continue;
    const token = value.slice(start, cursor);
    if ([...token].length > WEBVIEW_STYLE_LIMITS.classNameCodePoints) {
      throw new Error(
        `${label} contains a static class reference above the ${WEBVIEW_STYLE_LIMITS.classNameCodePoints}-code-point limit.`
      );
    }
    state.referenceTokens += 1;
    if (state.referenceTokens > WEBVIEW_STYLE_LIMITS.classReferenceTokens) {
      throw new Error(`${label} exceeds the ${WEBVIEW_STYLE_LIMITS.classReferenceTokens}-class-reference budget.`);
    }
    state.references.add(token);
  }
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function arrayJoinedByWhitespace(expression) {
  const current = unwrapExpression(expression);
  if (!ts.isCallExpression(current) || propertyName(current.expression) !== "join") return undefined;
  const delimiter = current.arguments[0];
  if (delimiter === undefined || !ts.isStringLiteralLike(delimiter) || ![...delimiter.text].some(isCssWhitespace)) {
    return undefined;
  }
  let receiver = unwrapExpression(current.expression.expression);
  while (ts.isCallExpression(receiver) && propertyName(receiver.expression) === "filter") {
    receiver = unwrapExpression(receiver.expression.expression);
  }
  return ts.isArrayLiteralExpression(receiver) ? receiver : undefined;
}

function collectClassExpression(expression, boundaries, state, label) {
  const current = unwrapExpression(expression);
  const joined = arrayJoinedByWhitespace(current);
  if (joined !== undefined) {
    for (const element of joined.elements) {
      if (!ts.isSpreadElement(element)) collectClassExpression(element, { left: true, right: true }, state, label);
    }
    return;
  }
  if (ts.isStringLiteralLike(current)) {
    addStaticClassText(current.text, boundaries, state, label);
    return;
  }
  if (ts.isConditionalExpression(current)) {
    collectClassExpression(current.whenTrue, boundaries, state, label);
    collectClassExpression(current.whenFalse, boundaries, state, label);
    return;
  }
  if (ts.isTemplateExpression(current)) {
    const parts = [current.head, ...current.templateSpans.map(({ literal }) => literal)];
    addStaticClassText(
      parts[0].text,
      {
        left: boundaries.left,
        right:
          current.templateSpans.length === 0
            ? boundaries.right
            : expressionHasBoundary(current.templateSpans[0].expression, "start")
      },
      state,
      label
    );
    for (let index = 0; index < current.templateSpans.length; index += 1) {
      const span = current.templateSpans[index];
      const before = parts[index].text;
      const after = parts[index + 1].text;
      collectClassExpression(
        span.expression,
        {
          left: stringEndsWithWhitespace(before) || (before === "" && index === 0 && boundaries.left),
          right:
            stringStartsWithWhitespace(after) ||
            (after === "" && index === current.templateSpans.length - 1 && boundaries.right)
        },
        state,
        label
      );
      const nextExpression = current.templateSpans[index + 1]?.expression;
      addStaticClassText(
        after,
        {
          left: expressionHasBoundary(span.expression, "end"),
          right: nextExpression === undefined ? boundaries.right : expressionHasBoundary(nextExpression, "start")
        },
        state,
        label
      );
    }
    return;
  }
  if (ts.isBinaryExpression(current)) {
    if (current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectClassExpression(current.right, boundaries, state, label);
      return;
    }
    if (
      current.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      current.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectClassExpression(current.left, boundaries, state, label);
      collectClassExpression(current.right, boundaries, state, label);
      return;
    }
    if (current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      collectClassExpression(
        current.left,
        { left: boundaries.left, right: expressionHasBoundary(current.right, "start") },
        state,
        label
      );
      collectClassExpression(
        current.right,
        { left: expressionHasBoundary(current.left, "end"), right: boundaries.right },
        state,
        label
      );
    }
  }
}

function bindingContainsName(name, expected) {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some(
    (element) => !ts.isOmittedExpression(element) && bindingContainsName(element.name, expected)
  );
}

function hasRuntimeBinding(document, expected, budget, label) {
  let found = false;
  const visit = (node) => {
    if (found) return;
    budget.consume(1, label);
    if (
      ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && bindingContainsName(node.name, expected)) ||
      (ts.isCatchClause(node) &&
        node.variableDeclaration !== undefined &&
        bindingContainsName(node.variableDeclaration.name, expected)) ||
      ((ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isEnumDeclaration(node) ||
        ts.isModuleDeclaration(node)) &&
        node.name !== undefined &&
        ts.isIdentifier(node.name) &&
        node.name.text === expected) ||
      (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && node.name.text === expected) ||
      (ts.isImportClause(node) && !node.isTypeOnly && node.name?.text === expected) ||
      (ts.isNamespaceImport(node) && !node.parent.isTypeOnly && node.name.text === expected) ||
      (ts.isImportSpecifier(node) && !node.isTypeOnly && !node.parent.parent.isTypeOnly && node.name.text === expected)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(document);
  return found;
}

function documentMethodCall(expression, methods, allowGlobalDocument) {
  const current = unwrapExpression(expression);
  return (
    allowGlobalDocument &&
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "document" &&
    methods.has(current.expression.name.text)
  );
}

function domExpression(expression, domState) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return domState.bindings.has(current.text);
  if (
    documentMethodCall(
      current,
      new Set(["createElement", "getElementById", "querySelector"]),
      domState.allowGlobalDocument
    )
  ) {
    return true;
  }
  return (
    domState.allowGlobalDocument &&
    ts.isPropertyAccessExpression(current) &&
    ts.isIdentifier(current.expression) &&
    current.expression.text === "document" &&
    ["body", "documentElement"].includes(current.name.text)
  );
}

function domCollectionExpression(expression, domState) {
  const current = unwrapExpression(expression);
  if (ts.isIdentifier(current)) return domState.collections.has(current.text);
  if (
    documentMethodCall(
      current,
      new Set(["getElementsByClassName", "getElementsByTagName", "querySelectorAll"]),
      domState.allowGlobalDocument
    )
  ) {
    return true;
  }
  return (
    ts.isCallExpression(current) &&
    ts.isPropertyAccessExpression(current.expression) &&
    ts.isIdentifier(current.expression.expression) &&
    current.expression.expression.text === "Array" &&
    current.expression.name.text === "from" &&
    current.arguments[0] !== undefined &&
    domCollectionExpression(current.arguments[0], domState)
  );
}

function discoverDomBindings(document, budget, label) {
  const domState = {
    allowGlobalDocument: !hasRuntimeBinding(document, "document", budget, label),
    bindings: new Set(),
    collections: new Set()
  };
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      budget.consume(1, label);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
        if (domExpression(node.initializer, domState) && !domState.bindings.has(node.name.text)) {
          domState.bindings.add(node.name.text);
          changed = true;
        }
        if (domCollectionExpression(node.initializer, domState) && !domState.collections.has(node.name.text)) {
          domState.collections.add(node.name.text);
          changed = true;
        }
      }
      if (
        ts.isForOfStatement(node) &&
        ts.isVariableDeclarationList(node.initializer) &&
        node.initializer.declarations.length === 1 &&
        ts.isIdentifier(node.initializer.declarations[0].name) &&
        domCollectionExpression(node.expression, domState)
      ) {
        const name = node.initializer.declarations[0].name.text;
        if (!domState.bindings.has(name)) {
          domState.bindings.add(name);
          changed = true;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(document);
  }
  return domState;
}

function classNameAssignment(node, domState) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    propertyName(node.left) !== "className"
  ) {
    return undefined;
  }
  const receiver = ts.isPropertyAccessExpression(node.left)
    ? node.left.expression
    : ts.isElementAccessExpression(node.left)
      ? node.left.expression
      : undefined;
  return receiver !== undefined && domExpression(receiver, domState) ? node.right : undefined;
}

function classListArguments(node, domState) {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return [];
  const method = node.expression.name.text;
  const owner = node.expression.expression;
  if (
    propertyName(owner) !== "classList" ||
    (!ts.isPropertyAccessExpression(owner) && !ts.isElementAccessExpression(owner)) ||
    !domExpression(owner.expression, domState)
  ) {
    return [];
  }
  if (method === "toggle") return node.arguments.slice(0, 1);
  if (method === "replace") return node.arguments.slice(1, 2);
  return method === "add" ? [...node.arguments] : [];
}

function setAttributeClassArgument(node, domState) {
  if (!ts.isCallExpression(node) || propertyName(node.expression) !== "setAttribute" || node.arguments.length < 2) {
    return undefined;
  }
  const receiver =
    ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
      ? node.expression.expression
      : undefined;
  if (receiver === undefined || !domExpression(receiver, domState)) return undefined;
  const name = node.arguments[0];
  return ts.isStringLiteralLike(name) && name.text.toLocaleLowerCase("en-US") === "class"
    ? node.arguments[1]
    : undefined;
}

function intrinsicJsxClassAttribute(node) {
  if (!ts.isJsxAttribute(node) || !ts.isIdentifier(node.name) || node.name.text !== "className") return false;
  const element = node.parent.parent;
  if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return false;
  return ts.isIdentifier(element.tagName) && /^[a-z]/u.test(element.tagName.text);
}

function runtimeModuleSpecifier(node) {
  if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
    if (node.importClause?.isTypeOnly) return undefined;
    if (
      node.importClause?.name === undefined &&
      node.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.length > 0 &&
      node.importClause.namedBindings.elements.every(({ isTypeOnly }) => isTypeOnly)
    ) {
      return undefined;
    }
    return node.moduleSpecifier.text;
  }
  if (
    ts.isExportDeclaration(node) &&
    !node.isTypeOnly &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteralLike(node.moduleSpecifier)
  ) {
    if (
      node.exportClause !== undefined &&
      ts.isNamedExports(node.exportClause) &&
      node.exportClause.elements.length > 0 &&
      node.exportClause.elements.every(({ isTypeOnly }) => isTypeOnly)
    ) {
      return undefined;
    }
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

function classReferences(source, path, budget, state) {
  budget.consume(source.length, path);
  const scriptKind = extname(path) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const document = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (document.parseDiagnostics.length > 0) {
    throw new Error(`${path} must parse before its class references can prove selector ownership.`);
  }
  const domState = discoverDomBindings(document, budget, path);
  const moduleSpecifiers = [];
  const visit = (node) => {
    budget.consume(1, path);
    const specifier = runtimeModuleSpecifier(node);
    if (specifier !== undefined) moduleSpecifiers.push(specifier);
    if (intrinsicJsxClassAttribute(node) && node.initializer !== undefined) {
      if (ts.isStringLiteral(node.initializer)) {
        addStaticClassText(node.initializer.text, { left: true, right: true }, state, path);
      } else if (ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
        collectClassExpression(node.initializer.expression, { left: true, right: true }, state, path);
      }
    } else {
      const assignment = classNameAssignment(node, domState);
      if (assignment !== undefined) collectClassExpression(assignment, { left: true, right: true }, state, path);
      for (const argument of classListArguments(node, domState)) {
        collectClassExpression(argument, { left: true, right: true }, state, path);
      }
      const attribute = setAttributeClassArgument(node, domState);
      if (attribute !== undefined) collectClassExpression(attribute, { left: true, right: true }, state, path);
    }
    ts.forEachChild(node, visit);
  };
  visit(document);
  return moduleSpecifiers;
}

async function resolveWorkbenchModule(webviewRoot, importer, specifier, filesystem, budget) {
  budget.consume(specifier.length + 1, relative(webviewRoot, importer));
  if (!specifier.startsWith(".")) return undefined;
  if (specifier.includes("\0") || Buffer.byteLength(specifier, "utf8") > 1_024) {
    throw new Error(`${relative(webviewRoot, importer)} contains an invalid or oversized relative module specifier.`);
  }
  const base = resolve(dirname(importer), specifier);
  const relativeBase = relative(webviewRoot, base);
  if (relativeBase === ".." || relativeBase.startsWith(`..${sep}`) || isAbsolute(relativeBase)) return undefined;
  const extension = extname(base);
  if (extension !== "" && ![".js", ".jsx", ".ts", ".tsx"].includes(extension)) return undefined;
  const withoutJavaScript = [".js", ".jsx"].includes(extension) ? base.slice(0, -extension.length) : base;
  const candidates =
    extension === ".ts" || extension === ".tsx"
      ? [base]
      : [`${withoutJavaScript}.ts`, `${withoutJavaScript}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")];
  for (const candidate of candidates) {
    budget.consume(1, relative(webviewRoot, importer));
    try {
      const metadata = await filesystem.lstat(candidate, { bigint: true });
      if (metadata.isSymbolicLink()) {
        throw new Error(`${relative(webviewRoot, candidate)} must not be a symbolic link.`);
      }
      if (metadata.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    `${relative(webviewRoot, importer)} imports ${JSON.stringify(specifier)}, but no contained TypeScript module resolves.`
  );
}

async function workbenchClassReferences(root, webviewRoot, filesystem, budget, state) {
  const entry = resolve(webviewRoot, "main.tsx");
  const pending = [entry];
  const visited = new Set();
  let sourceBytes = 0;
  while (pending.length > 0) {
    const path = pending.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > MAX_WEBVIEW_SOURCE_FILES) {
      throw new Error(`Workbench bundle closure exceeds ${MAX_WEBVIEW_SOURCE_FILES} TypeScript files.`);
    }
    const label = relative(root, path);
    const source = await readBoundedFile(root, path, MAX_WEBVIEW_SOURCE_FILE_BYTES, label, filesystem);
    sourceBytes += Buffer.byteLength(source, "utf8");
    if (sourceBytes > MAX_WEBVIEW_SOURCE_BYTES) {
      throw new Error(`Workbench bundle TypeScript sources exceed ${MAX_WEBVIEW_SOURCE_BYTES} bytes in total.`);
    }
    const specifiers = classReferences(source, label, budget, state);
    for (const specifier of specifiers) {
      const dependency = await resolveWorkbenchModule(webviewRoot, path, specifier, filesystem, budget);
      if (dependency !== undefined && !visited.has(dependency)) pending.push(dependency);
    }
  }
  return [...visited];
}

export async function checkWebviewStyles(root = repositoryRoot, options = {}) {
  const absoluteRoot = resolve(root);
  const filesystem = operationsFor(options);
  const budget = new WorkBudget();
  const webviewRoot = resolve(absoluteRoot, "src/webviews");
  const styleRoot = resolve(webviewRoot, "styles");
  const entryPath = resolve(webviewRoot, "styles.css");
  const entry = await readBoundedFile(absoluteRoot, entryPath, MAX_ENTRY_BYTES, "src/webviews/styles.css", filesystem);
  const parsedEntry = parseCss(entry, "src/webviews/styles.css", budget);
  const entryImports = parsedEntry.imports.filter(({ depth }) => depth === 0).map(({ target }) => target);
  const expectedImports = WEBVIEW_STYLE_IMPORTS.map((file) => `./styles/${file}`);
  if (
    parsedEntry.nonImportRules !== 0 ||
    parsedEntry.imports.some(({ depth }) => depth !== 0) ||
    JSON.stringify(entryImports) !== JSON.stringify(expectedImports)
  ) {
    throw new Error("src/webviews/styles.css must contain only the canonical owned-style imports in order.");
  }

  const styleEntries = await readStableDirectory(absoluteRoot, styleRoot, filesystem, "src/webviews/styles");
  if (styleEntries.some((entry_) => entry_.isSymbolicLink())) {
    throw new Error("Owned stylesheet inventory must not contain symbolic links.");
  }
  const actualStyleFiles = styleEntries
    .filter((entry_) => entry_.isFile() && extname(entry_.name) === ".css")
    .map((entry_) => entry_.name)
    .sort();
  const expectedStyleFiles = [...WEBVIEW_STYLE_IMPORTS].sort();
  if (JSON.stringify(actualStyleFiles) !== JSON.stringify(expectedStyleFiles)) {
    throw new Error(
      `Owned stylesheet inventory differs: expected ${expectedStyleFiles.join(", ")}; found ${actualStyleFiles.join(", ")}.`
    );
  }

  const classes = new Map();
  let styleBytes = 0;
  let selectorOccurrences = 0;
  let selectorRules = 0;
  for (const file of WEBVIEW_STYLE_IMPORTS) {
    const path = resolve(styleRoot, file);
    const source = await readBoundedFile(absoluteRoot, path, MAX_STYLE_FILE_BYTES, file, filesystem);
    styleBytes += Buffer.byteLength(source, "utf8");
    if (styleBytes > MAX_STYLE_BYTES) throw new Error(`Owned stylesheets exceed ${MAX_STYLE_BYTES} bytes in total.`);
    const parsed = parseCss(source, file, budget);
    if (parsed.imports.length > 0) {
      throw new Error(`${file} must not contain nested imports; styles.css owns the production order.`);
    }
    selectorOccurrences += parsed.selectorOccurrences;
    selectorRules += parsed.selectorRules;
    if (selectorOccurrences > WEBVIEW_STYLE_LIMITS.selectorOccurrences) {
      throw new Error(
        `Owned stylesheets exceed the ${WEBVIEW_STYLE_LIMITS.selectorOccurrences}-class-selector budget.`
      );
    }
    if (selectorRules > WEBVIEW_STYLE_LIMITS.selectorRules) {
      throw new Error(`Owned stylesheets exceed the ${WEBVIEW_STYLE_LIMITS.selectorRules}-rule selector budget.`);
    }
    const lines = lineCount(source);
    const limit = file === "foundations.css" ? MAX_FOUNDATION_LINES : MAX_OWNED_STYLESHEET_LINES;
    if (lines > limit) {
      throw new Error(
        `${file} has ${lines} lines, above its ${limit}-line ownership limit; split it before adding CSS.`
      );
    }
    for (const className of parsed.classes) {
      const owners = classes.get(className) ?? [];
      owners.push(file);
      classes.set(className, owners);
    }
  }

  const resurrected = [...REMOVED_SELECTORS].filter((className) => classes.has(className));
  if (resurrected.length > 0) {
    throw new Error(`Removed selector(s) must stay absent: ${resurrected.sort().join(", ")}.`);
  }

  const referenceState = { referenceTokens: 0, references: new Set() };
  const paths = await workbenchClassReferences(absoluteRoot, webviewRoot, filesystem, budget, referenceState);
  const dead = [...classes]
    .filter(([className]) => !referenceState.references.has(className))
    .map(([className, owners]) => `${className} (${owners.join(", ")})`)
    .sort();
  if (dead.length > 0) {
    throw new Error(`Unreferenced webview selector class(es): ${dead.join(", ")}.`);
  }

  return {
    entry: relative(absoluteRoot, entryPath),
    ownedStylesheets: WEBVIEW_STYLE_IMPORTS.length,
    selectorClasses: classes.size,
    sourceFiles: paths.length
  };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node scripts/check-webview-styles.mjs");
  }
  const receipt = await checkWebviewStyles();
  process.stdout.write(
    `Webview styles are owned and live: ${receipt.ownedStylesheets} files, ${receipt.selectorClasses} class selectors, ${receipt.sourceFiles} source files.\n`
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
