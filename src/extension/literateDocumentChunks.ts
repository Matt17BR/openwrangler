import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
  COLLECTION_STYLE_BLOCK,
  EVENT_ALIAS,
  EVENT_MAPPING,
  EVENT_POP,
  EVENT_SCALAR,
  EVENT_SEQUENCE,
  FAILSAFE_SCHEMA,
  SCALAR_STYLE_PLAIN,
  getScalarValue,
  load,
  parseEvents,
  type Event
} from "./vendor/js-yaml";
import {
  closesMarkdownOpaqueContainer,
  openingMarkdownOpaqueContainer,
  type MarkdownOpaqueContainer
} from "./markdownOpaqueContainers";

const MAX_LITERATE_DOCUMENT_BYTES = 64 * 1_024 * 1_024;
const MAX_EXECUTOR_YAML_BYTES = 1_024 * 1_024;
const MAX_EXECUTOR_YAML_DEPTH = 64;
const MAX_EXECUTOR_YAML_EVENTS = 16_384;

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

interface LiterateFrontMatter {
  readonly lines: ReadonlySet<number>;
  readonly yaml?: string;
}

interface YamlCollectionFrame {
  readonly kind: "mapping" | "sequence";
  expectingKey: boolean;
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
  const frontMatter = analyzeLiterateFrontMatter(lines);
  let fence: OpenFence | undefined;
  let htmlComment = false;
  let opaqueContainer: MarkdownOpaqueContainer | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index]!.text;
    if (!fence) {
      if (frontMatter.lines.has(index)) continue;
      if (opaqueContainer) {
        if (closesMarkdownOpaqueContainer(opaqueContainer, sourceLine)) opaqueContainer = undefined;
        continue;
      }
      const openedContainer = openingMarkdownOpaqueContainer(sourceLine);
      if (openedContainer?.kind === "raw-html") {
        opaqueContainer = openedContainer;
        continue;
      }
      const commentState = htmlCommentState(sourceLine, htmlComment);
      htmlComment = commentState.open;
      if (commentState.opaque) continue;
      const opening = openingFence(sourceLine);
      if (opening) {
        fence = { ...opening, openingLine: index };
        continue;
      }
      opaqueContainer = openedContainer;
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
  const frontMatter = analyzeLiterateFrontMatter(lines);
  const metadata = executorMetadata(frontMatter.yaml);
  if (metadata === "r" || metadata === "jupyter" || metadata === "unknown") return metadata;
  return containsExecutableRChunk(lines, frontMatter.lines) ? "r" : "jupyter";
}

type ExecutorMetadata = LiteratePythonExecutionOwner | "implicit";

function executorMetadata(yaml: string | undefined): ExecutorMetadata {
  if (yaml === undefined || yaml.trim().length === 0) return "implicit";
  if (Buffer.byteLength(yaml, "utf8") > MAX_EXECUTOR_YAML_BYTES) return "unknown";
  try {
    const events = parseEvents(yaml, { maxDepth: MAX_EXECUTOR_YAML_DEPTH });
    if (events.length > MAX_EXECUTOR_YAML_EVENTS || !hasSafePlainRootMapping(yaml, events)) return "unknown";
    const parsed = load(yaml, {
      schema: FAILSAFE_SCHEMA,
      json: false,
      maxAliases: 0,
      maxDepth: MAX_EXECUTOR_YAML_DEPTH,
      maxTotalMergeKeys: 0
    });
    if (parsed === undefined || parsed === null) return "implicit";
    if (!isPlainStringRecord(parsed)) return "unknown";

    const keys = Object.keys(parsed);
    for (const key of keys) {
      const normalized = key.toLowerCase();
      if ((normalized === "engine" || normalized === "jupyter" || normalized === "knitr") && key !== normalized) {
        return "unknown";
      }
    }
    const sawEngine = Object.hasOwn(parsed, "engine");
    const sawKnitr = Object.hasOwn(parsed, "knitr");
    const sawJupyter = Object.hasOwn(parsed, "jupyter");
    const engine = sawEngine ? parsed.engine : undefined;
    if (sawEngine && typeof engine !== "string") return "unknown";
    if ((sawKnitr && sawJupyter) || (engine === "knitr" && sawJupyter) || (engine === "jupyter" && sawKnitr)) {
      return "unknown";
    }
    if (engine !== undefined && engine !== "knitr" && engine !== "jupyter") return "unknown";
    if (engine === "knitr" || sawKnitr) return "r";
    if (engine === "jupyter" || sawJupyter) return "jupyter";
    return "implicit";
  } catch {
    return "unknown";
  }
}

function hasSafePlainRootMapping(yaml: string, events: readonly Event[]): boolean {
  const stack: YamlCollectionFrame[] = [];
  let sawRoot = false;
  for (const event of events) {
    if (hasYamlAnchorOrTag(event)) return false;
    if (event.type === EVENT_ALIAS) return false;
    if (event.type === EVENT_MAPPING || event.type === EVENT_SEQUENCE) {
      if (stack.length === 0) {
        if (sawRoot || event.type !== EVENT_MAPPING || event.style !== COLLECTION_STYLE_BLOCK) return false;
        sawRoot = true;
      } else if (!consumeYamlCollection(stack.at(-1)!)) {
        return false;
      }
      stack.push({ kind: event.type === EVENT_MAPPING ? "mapping" : "sequence", expectingKey: true });
      continue;
    }
    if (event.type === EVENT_SCALAR) {
      if (stack.length === 0) {
        if (sawRoot) continue;
        return false;
      }
      const parent = stack.at(-1)!;
      if (parent.kind === "mapping" && parent.expectingKey && stack.length === 1) {
        const key = getScalarValue(yaml, event);
        const normalized = key.toLowerCase();
        const keyColumn = yamlColumn(yaml, event.valueStart) - (event.style === SCALAR_STYLE_PLAIN ? 0 : 1);
        if (keyColumn !== 0) return false;
        if ((normalized === "engine" || normalized === "jupyter" || normalized === "knitr") && key !== normalized) {
          return false;
        }
        if (
          (normalized === "engine" || normalized === "jupyter" || normalized === "knitr") &&
          event.style !== SCALAR_STYLE_PLAIN
        ) {
          return false;
        }
      }
      consumeYamlScalar(parent);
      continue;
    }
    if (event.type === EVENT_POP && stack.length > 0) stack.pop();
  }
  return sawRoot && stack.length === 0;
}

function consumeYamlCollection(frame: YamlCollectionFrame): boolean {
  if (frame.kind === "sequence") return true;
  if (frame.expectingKey) return false;
  frame.expectingKey = true;
  return true;
}

function consumeYamlScalar(frame: YamlCollectionFrame): void {
  if (frame.kind === "mapping") frame.expectingKey = !frame.expectingKey;
}

function hasYamlAnchorOrTag(event: Event): boolean {
  if (!("anchorStart" in event)) return false;
  return event.anchorEnd > event.anchorStart || ("tagStart" in event && event.tagEnd > event.tagStart);
}

function yamlColumn(yaml: string, offset: number): number {
  const before = Math.max(0, offset - 1);
  return offset - (Math.max(yaml.lastIndexOf("\n", before), yaml.lastIndexOf("\r", before)) + 1);
}

function isPlainStringRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function containsExecutableRChunk(lines: readonly SourceLine[], frontMatter: ReadonlySet<number>): boolean {
  let fence: OpenFence | undefined;
  let htmlComment = false;
  let opaqueContainer: MarkdownOpaqueContainer | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const sourceLine = lines[index]!.text;
    if (!fence) {
      if (frontMatter.has(index)) continue;
      if (opaqueContainer) {
        if (closesMarkdownOpaqueContainer(opaqueContainer, sourceLine)) opaqueContainer = undefined;
        continue;
      }
      const openedContainer = openingMarkdownOpaqueContainer(sourceLine);
      if (openedContainer?.kind === "raw-html") {
        opaqueContainer = openedContainer;
        continue;
      }
      const commentState = htmlCommentState(sourceLine, htmlComment);
      htmlComment = commentState.open;
      if (commentState.opaque) continue;
      const opening = openingFence(sourceLine);
      if (opening) {
        fence = { ...opening, openingLine: index };
        continue;
      }
      opaqueContainer = openedContainer;
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

function analyzeLiterateFrontMatter(lines: readonly SourceLine[]): LiterateFrontMatter {
  const ignored = new Set<number>();
  if (lines[0]?.text.replace(/^\uFEFF/u, "").trimEnd() !== "---") return Object.freeze({ lines: ignored });
  ignored.add(0);
  for (let index = 1; index < lines.length; index += 1) {
    ignored.add(index);
    if (/^(?:---|\.\.\.)[\t ]*$/u.test(lines[index]!.text)) {
      return Object.freeze({
        lines: ignored,
        yaml: lines
          .slice(1, index)
          .map((line) => line.text + line.ending)
          .join("")
      });
    }
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
