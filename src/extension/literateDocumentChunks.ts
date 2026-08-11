import { Buffer } from "node:buffer";
import * as path from "node:path";

const MAX_LITERATE_DOCUMENT_BYTES = 64 * 1_024 * 1_024;

export type LiterateDocumentKind = "rmarkdown" | "quarto";
export type LiterateChunkLanguage = "python" | "r";
export type LiteratePythonExecutionOwner = "r" | "jupyter" | "unknown";

export interface LiterateCodeChunk {
  readonly language?: LiterateChunkLanguage;
  readonly executableSyntax: boolean;
  readonly supportedFence: boolean;
  readonly enabled: boolean;
  readonly fenceCharacter: "`" | "~";
  readonly openingLine: number;
  readonly codeStartLine: number;
  readonly codeEndLine: number;
  readonly closingLine: number;
  readonly code: string;
}

interface SourceLine {
  readonly text: string;
  readonly ending: string;
}

interface OpenFence {
  readonly character: "`" | "~";
  readonly length: number;
  readonly indent: number;
  readonly info: string;
  readonly openingLine: number;
}

export function literateDocumentKind(filePath: string): LiterateDocumentKind | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".rmd":
      return "rmarkdown";
    case ".qmd":
      return "quarto";
    default:
      return undefined;
  }
}

/** Finds the one fenced code block that owns a zero-based source line. */
export function findLiterateCodeChunkAtLine(
  filePath: string,
  source: string,
  line: number
): LiterateCodeChunk | undefined {
  const kind = literateDocumentKind(filePath);
  if (!kind) return undefined;
  if (!Number.isSafeInteger(line) || line < 0) throw new RangeError("The document cursor line is invalid.");
  if (Buffer.byteLength(source, "utf8") > MAX_LITERATE_DOCUMENT_BYTES) {
    throw new RangeError("The literate document exceeds the supported 64 MiB source limit.");
  }

  const lines = splitSourceLines(source);
  if (line >= Math.max(1, lines.length)) return undefined;
  const frontMatter = frontMatterLines(lines);
  let fence: OpenFence | undefined;
  let htmlComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index]!.text;
    if (!fence) {
      if (frontMatter.has(index)) continue;
      const commentState = htmlCommentState(sourceLine, htmlComment);
      htmlComment = commentState.open;
      if (commentState.opaque) continue;
      const opening = openingFence(sourceLine);
      if (!opening) continue;
      fence = { ...opening, openingLine: index };
      continue;
    }

    if (!isClosingFence(sourceLine, fence.character, fence.length)) continue;
    if (line >= fence.openingLine && line <= index) {
      return freezeChunk(kind, lines, fence, index);
    }
    fence = undefined;
  }

  if (fence && line >= fence.openingLine) {
    throw new SyntaxError(`The code fence opened on line ${fence.openingLine + 1} is not closed.`);
  }
  return undefined;
}

/**
 * Mirrors Quarto's public document-level executor choice for Python cells.
 * R Markdown is always knitr-owned. Quarto front matter may select knitr or
 * Jupyter explicitly; otherwise the presence of an R cell selects knitr.
 * Malformed, conflicting, or unsupported executor metadata fails closed.
 */
export function literatePythonExecutionOwner(filePath: string, source: string): LiteratePythonExecutionOwner {
  const kind = literateDocumentKind(filePath);
  if (!kind) return "unknown";
  if (Buffer.byteLength(source, "utf8") > MAX_LITERATE_DOCUMENT_BYTES) {
    throw new RangeError("The literate document exceeds the supported 64 MiB source limit.");
  }
  if (kind === "rmarkdown") return "r";

  const lines = splitSourceLines(source);
  const frontMatter = frontMatterLines(lines);
  const metadata = executorMetadata(lines, frontMatter);
  if (metadata === "r" || metadata === "jupyter" || metadata === "unknown") return metadata;
  return containsExecutableRChunk(lines, frontMatter) ? "r" : "jupyter";
}

type ExecutorMetadata = LiteratePythonExecutionOwner | "implicit";

function executorMetadata(lines: readonly SourceLine[], frontMatter: ReadonlySet<number>): ExecutorMetadata {
  if (frontMatter.size === 0) return "implicit";
  let engine: string | undefined;
  let sawEngine = false;
  let sawKnitr = false;
  let sawJupyter = false;
  for (let index = 1; index < lines.length && frontMatter.has(index); index += 1) {
    const text = lines[index]!.text;
    if (/^(?:---|\.\.\.)[\t ]*$/u.test(text)) break;
    if (text.trim().length === 0 || /^\s*#/u.test(text)) continue;
    if (/^[\t ]/u.test(text)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(.*)$/u.exec(text);
    if (!match) return "unknown";
    const key = match[1]!.toLowerCase();
    if (key !== "engine" && key !== "knitr" && key !== "jupyter") continue;
    if (key === "engine") {
      if (sawEngine) return "unknown";
      sawEngine = true;
      const scalar = plainYamlScalar(match[2]!);
      if (!scalar) return "unknown";
      engine = scalar.toLowerCase();
    } else if (key === "knitr") {
      if (sawKnitr) return "unknown";
      sawKnitr = true;
    } else {
      if (sawJupyter) return "unknown";
      sawJupyter = true;
    }
  }
  if ((sawKnitr && sawJupyter) || (engine === "knitr" && sawJupyter) || (engine === "jupyter" && sawKnitr)) {
    return "unknown";
  }
  if (engine !== undefined && engine !== "knitr" && engine !== "jupyter") return "unknown";
  if (engine === "knitr" || sawKnitr) return "r";
  if (engine === "jupyter" || sawJupyter) return "jupyter";
  return "implicit";
}

function plainYamlScalar(value: string): string | undefined {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  const quoted = /^(?:"([^"\\]*)"|'([^']*)')$/u.exec(withoutComment);
  if (quoted) return quoted[1] ?? quoted[2];
  return /^[A-Za-z][A-Za-z0-9_.+-]*$/u.test(withoutComment) ? withoutComment : undefined;
}

function containsExecutableRChunk(lines: readonly SourceLine[], frontMatter: ReadonlySet<number>): boolean {
  let fence: OpenFence | undefined;
  let htmlComment = false;
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index]!.text;
    if (!fence) {
      if (frontMatter.has(index)) continue;
      const commentState = htmlCommentState(sourceLine, htmlComment);
      htmlComment = commentState.open;
      if (commentState.opaque) continue;
      const opening = openingFence(sourceLine);
      if (!opening) continue;
      fence = { ...opening, openingLine: index };
      continue;
    }
    if (!isClosingFence(sourceLine, fence.character, fence.length)) continue;
    const header = executableHeader(fence.info);
    if (header.language === "r") return true;
    fence = undefined;
  }
  if (fence) throw new SyntaxError(`The code fence opened on line ${fence.openingLine + 1} is not closed.`);
  return false;
}

function freezeChunk(
  kind: LiterateDocumentKind,
  lines: readonly SourceLine[],
  fence: OpenFence,
  closingLine: number
): LiterateCodeChunk {
  const header = executableHeader(fence.info);
  const body = lines.slice(fence.openingLine + 1, closingLine);
  const code = body.map((line) => deindent(line.text, fence.indent) + line.ending).join("");
  return Object.freeze({
    ...(header.language ? { language: header.language } : {}),
    executableSyntax: header.executableSyntax,
    supportedFence: fence.character === "`" || kind === "quarto",
    enabled: !chunkEvaluationDisabled(fence.info, body),
    fenceCharacter: fence.character,
    openingLine: fence.openingLine,
    codeStartLine: fence.openingLine + 1,
    codeEndLine: Math.max(fence.openingLine, closingLine - 1),
    closingLine,
    code
  });
}

function executableHeader(info: string): Readonly<{
  language?: LiterateChunkLanguage;
  executableSyntax: boolean;
}> {
  const match = /^\{\s*([A-Za-z][A-Za-z0-9_.+-]*)(?:[\s,][\s\S]*)?\}\s*$/u.exec(info);
  if (!match) return Object.freeze({ executableSyntax: false });
  const language = match[1]!.toLowerCase();
  if (language === "python" || language === "r") {
    return Object.freeze({ language, executableSyntax: true });
  }
  return Object.freeze({ executableSyntax: true });
}

function chunkEvaluationDisabled(info: string, body: readonly SourceLine[]): boolean {
  const header = info.slice(1, -1);
  if (/(?:^|[\s,])eval\s*=\s*(?:false|f)(?=$|[\s,])/iu.test(header)) return true;
  for (const { text } of body) {
    const option = /^\s*#\|\s*(?:eval|enabled)\s*:\s*(false|no|off|0)\s*(?:#.*)?$/iu.exec(text);
    if (option) return true;
  }
  return false;
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

function frontMatterLines(lines: readonly SourceLine[]): ReadonlySet<number> {
  const ignored = new Set<number>();
  if (lines[0]?.text.replace(/^\uFEFF/u, "").trimEnd() !== "---") return ignored;
  ignored.add(0);
  for (let index = 1; index < lines.length; index += 1) {
    ignored.add(index);
    if (/^(?:---|\.\.\.)[\t ]*$/u.test(lines[index]!.text)) return ignored;
  }
  throw new SyntaxError("The document YAML front matter is not closed.");
}

function openingFence(
  line: string
): Readonly<{ character: "`" | "~"; length: number; indent: number; info: string }> | undefined {
  const match = /^( {0,3})(`{3,}|~{3,})([^\r\n]*)$/u.exec(line);
  if (!match) return undefined;
  const marker = match[2]!;
  const info = match[3]!.trim();
  if (marker[0] === "`" && info.includes("`")) return undefined;
  return Object.freeze({
    character: marker[0] as "`" | "~",
    length: marker.length,
    indent: match[1]!.length,
    info
  });
}

function isClosingFence(line: string, character: "`" | "~", minimumLength: number): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[\t ]*$/u.exec(line);
  return Boolean(match && match[1]![0] === character && match[1]!.length >= minimumLength);
}

function deindent(line: string, maximum: number): string {
  let count = 0;
  while (count < maximum && line[count] === " ") count += 1;
  return line.slice(count);
}

function htmlCommentState(line: string, alreadyOpen: boolean): Readonly<{ open: boolean; opaque: boolean }> {
  let open = alreadyOpen;
  let opaque = alreadyOpen;
  let offset = 0;
  while (offset < line.length) {
    if (open) {
      const close = line.indexOf("-->", offset);
      if (close < 0) return Object.freeze({ open: true, opaque: true });
      open = false;
      opaque = true;
      offset = close + 3;
      continue;
    }
    const start = line.indexOf("<!--", offset);
    if (start < 0) break;
    open = true;
    opaque = true;
    offset = start + 4;
  }
  return Object.freeze({ open, opaque });
}
