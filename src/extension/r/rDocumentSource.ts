import * as path from "node:path";
import { Buffer } from "node:buffer";

const MAX_DOCUMENT_BYTES = 64 * 1_024 * 1_024;
const MAX_RUNNABLE_R_CHUNKS = 1_024;

export type RDocumentKind = "r" | "rmarkdown" | "quarto";

export interface PreparedRDocumentSource {
  readonly kind: RDocumentKind;
  readonly executableText: string;
  readonly executableUnits: readonly string[];
  readonly rChunkCount: number;
  readonly runnableRChunkCount: number;
}

interface SourceLine {
  readonly text: string;
  readonly ending: string;
}

interface Fence {
  readonly character: "`" | "~";
  readonly length: number;
  readonly indent: number;
  readonly r: boolean;
  readonly runnable: boolean;
  readonly openingLine: number;
  readonly body: number[];
}

interface OpaqueMarkdownContainer {
  readonly kind: "display-math" | "raw-tex";
  readonly closingMarker: string;
}

/** Returns the supported R document kind without consulting editor language IDs. */
export function rDocumentKind(filePath: string): RDocumentKind | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".r":
      return "r";
    case ".rmd":
      return "rmarkdown";
    case ".qmd":
      return "quarto";
    default:
      return undefined;
  }
}

/**
 * Prepares the exact R program owned by a source document.
 *
 * Plain R files run unchanged. For Quarto and R Markdown, prose, YAML, and
 * non-R cells become blank lines while runnable fenced R cells retain their
 * original line numbers. This is execution for dataframe discovery, not a
 * replacement for rendering the document.
 */
export function prepareRDocumentSource(filePath: string, source: string): PreparedRDocumentSource {
  const kind = rDocumentKind(filePath);
  if (!kind) throw new TypeError("Open Wrangler supports .R, .Rmd, and .qmd R documents.");
  assertBoundedUnicodeSource(source);
  if (kind === "r") {
    return Object.freeze({
      kind,
      executableText: source,
      executableUnits: Object.freeze([source]),
      rChunkCount: 0,
      runnableRChunkCount: 0
    });
  }

  const lines = splitSourceLines(source);
  const output = lines.map((line) => line.ending);
  const frontMatter = analyzeFrontMatter(lines);
  let fence: Fence | undefined;
  let htmlCommentLine: number | undefined;
  let multilineCodeSpanTicks: number | undefined;
  let opaqueContainer: OpaqueMarkdownContainer | undefined;
  let rChunkCount = 0;
  let runnableRChunkCount = 0;
  const executableUnits: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.text;
    if (!fence) {
      if (frontMatter.lines.has(index)) continue;
      if (opaqueContainer) {
        const nestedFence = openingFence(line);
        if (nestedFence && isRFenceInfo(nestedFence.info)) {
          throw new SyntaxError(
            `Open Wrangler cannot safely distinguish an R cell inside ${opaqueContainerLabel(opaqueContainer)} near line ${index + 1}.`
          );
        }
        if (line.includes(opaqueContainer.closingMarker)) opaqueContainer = undefined;
        continue;
      }
      if (htmlCommentLine !== undefined) {
        const commentEnd = line.indexOf("-->");
        if (commentEnd >= 0) {
          htmlCommentLine = undefined;
          rejectUnsupportedMarkdownContainer(line.slice(commentEnd + 3), index + 1);
        }
        continue;
      }
      const opening = multilineCodeSpanTicks === undefined ? openingFence(line) : undefined;
      if (opening) {
        const r = isRFenceInfo(opening.info);
        if (r && opening.character !== "`") {
          throw new SyntaxError(
            `Open Wrangler supports R cells fenced with backticks, not tildes (line ${index + 1}).`
          );
        }
        if (r && opening.indent !== 0) {
          throw new SyntaxError(`Open Wrangler supports only top-level R code fences (line ${index + 1}).`);
        }
        const runnable = r && !rChunkOptionsDisableEvaluation(opening.info, []);
        if (r) rChunkCount += 1;
        fence = {
          character: opening.character,
          length: opening.length,
          indent: opening.indent,
          r,
          runnable,
          openingLine: index + 1,
          body: []
        };
        continue;
      }
      const commentStart = line.indexOf("<!--");
      if (commentStart >= 0) {
        const commentEnd = line.indexOf("-->", commentStart + 4);
        const visibleText =
          commentEnd < 0 ? line.slice(0, commentStart) : line.slice(0, commentStart) + line.slice(commentEnd + 3);
        rejectUnsupportedMarkdownContainer(visibleText, index + 1);
        const openedContainer = openingOpaqueMarkdownContainer(visibleText);
        if (openedContainer) opaqueContainer = openedContainer;
        if (commentEnd < 0) htmlCommentLine = index + 1;
        continue;
      }
      rejectUnsupportedMarkdownContainer(line, index + 1);
      if (multilineCodeSpanTicks !== undefined) {
        if (containsExactBacktickRun(line, multilineCodeSpanTicks)) multilineCodeSpanTicks = undefined;
        continue;
      }
      const openedContainer = openingOpaqueMarkdownContainer(line);
      if (openedContainer) {
        opaqueContainer = openedContainer;
        continue;
      }
      const codeSpanTicks = unmatchedBacktickRun(line);
      if (codeSpanTicks !== undefined) {
        multilineCodeSpanTicks = codeSpanTicks;
        continue;
      }
      continue;
    }

    const closingLength = kind === "rmarkdown" && fence.r ? 3 : fence.length;
    if (isClosingFence(line, fence.character, closingLength)) {
      if (
        fence.r &&
        fence.runnable &&
        frontMatter.executionEnabled &&
        !rChunkOptionsDisableEvaluation(
          "{r}",
          fence.body.map((bodyIndex) => lines[bodyIndex]!.text)
        )
      ) {
        runnableRChunkCount += 1;
        if (runnableRChunkCount > MAX_RUNNABLE_R_CHUNKS) {
          throw new RangeError(`The document exceeds the supported ${MAX_RUNNABLE_R_CHUNKS} runnable R cells.`);
        }
        const unit: string[] = [];
        for (const bodyIndex of fence.body) {
          const bodyLine = deindentFenceLine(lines[bodyIndex]!.text, fence.indent) + lines[bodyIndex]!.ending;
          output[bodyIndex] = bodyLine;
          unit.push(bodyLine);
        }
        executableUnits.push(unit.join(""));
      }
      fence = undefined;
      continue;
    }
    fence.body.push(index);
  }

  if (fence) {
    throw new SyntaxError(
      fence.r
        ? `The R code fence opened on line ${fence.openingLine} is not closed.`
        : `The code fence opened on line ${fence.openingLine} is not closed.`
    );
  }
  if (htmlCommentLine !== undefined) {
    throw new SyntaxError(`The HTML comment opened on line ${htmlCommentLine} is not closed.`);
  }

  return Object.freeze({
    kind,
    executableText: output.join(""),
    executableUnits: Object.freeze(executableUnits),
    rChunkCount,
    runnableRChunkCount
  });
}

/** Wraps generated R in a real executable cell when inserting into a literate document. */
export function formatGeneratedRDocumentCode(filePath: string, code: string): string {
  const kind = rDocumentKind(filePath);
  if (!kind) throw new TypeError("Generated R can be inserted only into .R, .Rmd, or .qmd documents.");
  if (kind === "r") return code;
  const trimmed = code.trimEnd();
  if (kind === "rmarkdown" && /^[\t ]*`{3,}[\t ]*$/mu.test(trimmed)) {
    throw new SyntaxError("Generated R contains a line that would close an R Markdown code cell.");
  }
  const fence = kind === "rmarkdown" ? "```" : "`".repeat(Math.max(3, longestBacktickRun(trimmed) + 1));
  return `${fence}{r}\n${trimmed}\n${fence}`;
}

export function rDocumentLabel(kind: RDocumentKind): string {
  switch (kind) {
    case "r":
      return "R file";
    case "rmarkdown":
      return "R Markdown document";
    case "quarto":
      return "Quarto document";
  }
}

function splitSourceLines(source: string): SourceLine[] {
  if (source.length === 0) return [];
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character !== "\r" && character !== "\n") continue;
    const ending = character === "\r" && source[index + 1] === "\n" ? "\r\n" : character;
    lines.push({ text: source.slice(start, index), ending });
    if (ending === "\r\n") index += 1;
    start = index + 1;
  }
  if (start < source.length) lines.push({ text: source.slice(start), ending: "" });
  return lines;
}

function analyzeFrontMatter(
  lines: readonly SourceLine[]
): Readonly<{ lines: ReadonlySet<number>; executionEnabled: boolean }> {
  const ignored = new Set<number>();
  if (lines[0]?.text.replace(/^\uFEFF/u, "").trimEnd() !== "---") {
    return { lines: ignored, executionEnabled: true };
  }
  ignored.add(0);
  let closingIndex: number | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    ignored.add(index);
    if (/^(?:---|\.\.\.)[\t ]*$/u.test(lines[index]!.text)) {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === undefined) throw new SyntaxError("The document YAML front matter is not closed.");

  let executionEnabled = true;
  let executeIndent: number | undefined;
  let blockScalarIndent: number | undefined;
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index]!.text;
    if (/^\s*(?:#.*)?$/u.test(line)) continue;
    const lineIndent = leadingSpaces(line);
    if (blockScalarIndent !== undefined && lineIndent > blockScalarIndent) continue;
    blockScalarIndent = undefined;
    if (/^\s*["']/u.test(line)) {
      throw new SyntaxError("Open Wrangler supports only unquoted YAML keys in R documents.");
    }
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/u.exec(line);
    if (!match) {
      const sequence = /^(\s*)-\s+\S/u.exec(line);
      if (sequence && (executeIndent === undefined || sequence[1]!.length <= executeIndent)) continue;
      throw new SyntaxError(`Open Wrangler does not support this YAML syntax on line ${index + 1}.`);
    }
    const indent = match[1]!.length;
    const key = match[2]!.toLowerCase();
    const value = stripYamlComment(match[3]!);
    if (/^[|>][1-9]?[+-]?$/u.test(value)) blockScalarIndent = indent;
    if (indent === 0) {
      executeIndent = key === "execute" ? indent : undefined;
      if (["jupyter", "engine", "params", "runtime", "server"].includes(key)) {
        throw new SyntaxError(
          `Open Wrangler cannot safely run this document because its YAML uses ${JSON.stringify(key)}.`
        );
      }
      if (key === "execute" && value.length > 0) {
        throw new SyntaxError("Open Wrangler supports only block-style execute options in document YAML.");
      }
      continue;
    }
    if (executeIndent !== undefined && indent > executeIndent && (key === "eval" || key === "enabled")) {
      const parsed = literalBoolean(value, `YAML execute.${key}`);
      if (!parsed) executionEnabled = false;
    }
  }
  return { lines: ignored, executionEnabled };
}

function openingFence(
  line: string
): Readonly<{ character: "`" | "~"; length: number; indent: number; info: string }> | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
  if (!match) return undefined;
  const marker = match[2]!;
  const info = match[3]!.trim();
  if (marker[0] === "`" && info.includes("`")) return undefined;
  return {
    character: marker[0] as "`" | "~",
    length: marker.length,
    indent: match[1]!.length,
    info
  };
}

function isClosingFence(line: string, character: "`" | "~", minimumLength: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line);
  return Boolean(match && match[1]![0] === character && match[1]!.length >= minimumLength);
}

function isRFenceInfo(info: string): boolean {
  return /^\{r(?:[\s,][^}]*)?\}$/iu.test(info);
}

function rChunkOptionsDisableEvaluation(info: string, body: readonly string[]): boolean {
  const executionOverrides = ["engine", "child", "code", "file", "ref.label", "opts.label"];
  let disabled = false;
  let headerEvalSeen = false;
  for (const option of parseRChunkHeaderOptions(info)) {
    const key = option.key.toLowerCase();
    if (executionOverrides.includes(key)) {
      throw new SyntaxError(`Open Wrangler does not run R chunks that use the ${key} option.`);
    }
    if (key === "eval") {
      if (headerEvalSeen) throw new SyntaxError("Open Wrangler does not run R chunks with repeated eval options.");
      headerEvalSeen = true;
      disabled = !literalBoolean(option.value, "R chunk eval");
    }
  }

  for (const line of body) {
    const directive = /^\s*#\|\s*(.*?)\s*$/u.exec(line);
    if (!directive) continue;
    if (directive[1]!.length === 0 || !/^[A-Za-z][A-Za-z0-9_.-]*\s*:/u.test(directive[1]!)) {
      throw new SyntaxError("Open Wrangler supports only plain key: value R cell options.");
    }
    const option = /^\s*#\|\s*([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/u.exec(line);
    if (!option) throw new SyntaxError("Open Wrangler supports only plain key: value R cell options.");
    const key = option[1]!.toLowerCase();
    const value = stripYamlComment(option[2]!);
    if (executionOverrides.includes(key)) {
      throw new SyntaxError(`Open Wrangler does not run R chunks that use the ${key} option.`);
    }
    if (key === "eval" && !literalBoolean(value, "R cell eval")) disabled = true;
  }
  return disabled;
}

function parseRChunkHeaderOptions(info: string): readonly Readonly<{ key: string; value: string }>[] {
  const content = info.slice(1, -1).trim();
  if (!/^r(?:$|[\s,])/iu.test(content)) return [];
  let rest = content.slice(1).trim();
  if (rest.length === 0) return [];
  if (rest.startsWith(",")) {
    rest = rest.slice(1).trim();
  } else {
    const firstComma = rest.indexOf(",");
    const first = (firstComma < 0 ? rest : rest.slice(0, firstComma)).trim();
    if (!first.includes("=")) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(first)) {
        throw new SyntaxError("Open Wrangler supports only plain R chunk labels and options.");
      }
      if (firstComma < 0) return [];
      rest = rest.slice(firstComma + 1).trim();
    }
  }
  if (rest.length === 0) return [];

  return splitRChunkHeaderOptions(rest).map((raw) => {
    const match = /^([A-Za-z][A-Za-z0-9_.-]*)\s*=\s*(.+)$/u.exec(raw.trim());
    if (!match) throw new SyntaxError("Open Wrangler supports only plain key=value R chunk options.");
    return Object.freeze({ key: match[1]!, value: match[2]!.trim() });
  });
}

function splitRChunkHeaderOptions(value: string): string[] {
  const parts: string[] = [];
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : (quote ?? character);
      continue;
    }
    if (!quote && character === ",") {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (quote || escaped) throw new SyntaxError("Open Wrangler does not run R chunks with incomplete quoted options.");
  parts.push(value.slice(start));
  return parts;
}

function longestBacktickRun(value: string): number {
  let longest = 0;
  for (const match of value.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  return longest;
}

function rejectUnsupportedMarkdownContainer(line: string, lineNumber: number): void {
  const trimmed = stripLeadingMarkdownListMarker(line.trimStart());
  if (/<[A-Za-z!/?]/u.test(trimmed)) {
    throw new SyntaxError(`Open Wrangler cannot safely distinguish R cells inside raw HTML near line ${lineNumber}.`);
  }
}

function openingOpaqueMarkdownContainer(line: string): OpaqueMarkdownContainer | undefined {
  const trimmed = stripLeadingMarkdownListMarker(line.trimStart());
  const displayDollar = trimmed.indexOf("$$");
  if (displayDollar >= 0 && trimmed.indexOf("$$", displayDollar + 2) < 0) {
    return { kind: "display-math", closingMarker: "$$" };
  }
  const displayBracket = trimmed.indexOf("\\[");
  if (displayBracket >= 0 && trimmed.indexOf("\\]", displayBracket + 2) < 0) {
    return { kind: "display-math", closingMarker: "\\]" };
  }
  const environment = /\\begin\{([A-Za-z][A-Za-z0-9*._-]*)\}/u.exec(trimmed);
  if (!environment) return undefined;
  const closingMarker = `\\end{${environment[1]!}}`;
  if (trimmed.includes(closingMarker, environment.index + environment[0].length)) return undefined;
  return { kind: "raw-tex", closingMarker };
}

function opaqueContainerLabel(container: OpaqueMarkdownContainer): string {
  return container.kind === "display-math" ? "display math" : "raw TeX";
}

function unmatchedBacktickRun(line: string): number | undefined {
  if (openingFence(line)) return undefined;
  let open: number | undefined;
  for (const match of line.matchAll(/`+/gu)) {
    const length = match[0].length;
    if (open === undefined) open = length;
    else if (open === length) open = undefined;
  }
  return open;
}

function containsExactBacktickRun(line: string, length: number): boolean {
  for (const match of line.matchAll(/`+/gu)) {
    if (match[0].length === length) return true;
  }
  return false;
}

function leadingSpaces(value: string): number {
  let count = 0;
  while (value[count] === " ") count += 1;
  return count;
}

function stripLeadingMarkdownListMarker(value: string): string {
  return value.replace(/^(?:[-+*]|\d{1,9}[.)])[\t ]+/u, "").trimStart();
}

function deindentFenceLine(line: string, indent: number): string {
  let offset = 0;
  while (offset < indent && line[offset] === " ") offset += 1;
  return line.slice(offset);
}

function literalBoolean(value: string, label: string): boolean {
  const normalized = unquote(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new SyntaxError(`Open Wrangler supports only literal true or false for ${label}.`);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripYamlComment(value: string): string {
  return value.replace(/\s+#.*$/u, "").trim();
}

function assertBoundedUnicodeSource(source: string): void {
  if (hasUnpairedSurrogate(source)) throw new TypeError("The R document must be valid Unicode text.");
  if (Buffer.byteLength(source, "utf8") > MAX_DOCUMENT_BYTES) {
    throw new RangeError("The R document exceeds the supported 64 MiB source limit.");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
