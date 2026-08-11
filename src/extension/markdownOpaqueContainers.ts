export type MarkdownOpaqueContainerKind = "display-math" | "raw-html" | "raw-tex";

export interface MarkdownOpaqueContainer {
  readonly kind: MarkdownOpaqueContainerKind;
  readonly closingMarker: string;
  readonly caseInsensitive: boolean;
}

const RAW_HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
]);

/**
 * Finds Markdown containers whose contents must not be interpreted as fenced
 * executable cells. Callers still decide whether to ignore or reject them.
 */
export function openingMarkdownOpaqueContainer(line: string): MarkdownOpaqueContainer | undefined {
  const trimmed = stripLeadingMarkdownListMarker(line.trimStart());
  const displayDollar = trimmed.indexOf("$$");
  if (displayDollar >= 0 && trimmed.indexOf("$$", displayDollar + 2) < 0) {
    return Object.freeze({ kind: "display-math", closingMarker: "$$", caseInsensitive: false });
  }
  const displayBracket = trimmed.indexOf("\\[");
  if (displayBracket >= 0 && trimmed.indexOf("\\]", displayBracket + 2) < 0) {
    return Object.freeze({ kind: "display-math", closingMarker: "\\]", caseInsensitive: false });
  }
  const environment = /\\begin\{([A-Za-z][A-Za-z0-9*._-]*)\}/u.exec(trimmed);
  if (environment) {
    const closingMarker = `\\end{${environment[1]!}}`;
    if (!trimmed.includes(closingMarker, environment.index + environment[0].length)) {
      return Object.freeze({ kind: "raw-tex", closingMarker, caseInsensitive: false });
    }
  }

  if (trimmed.startsWith("<?") && !trimmed.includes("?>", 2)) {
    return Object.freeze({ kind: "raw-html", closingMarker: "?>", caseInsensitive: false });
  }
  if (trimmed.startsWith("<![CDATA[") && !trimmed.includes("]]>", 9)) {
    return Object.freeze({ kind: "raw-html", closingMarker: "]]>", caseInsensitive: false });
  }
  const openingTag = /^<([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/u.exec(trimmed);
  if (!openingTag) return undefined;
  const tag = openingTag[1]!.toLowerCase();
  if (RAW_HTML_VOID_ELEMENTS.has(tag) || /\/\s*>$/u.test(openingTag[0])) return undefined;
  const closingMarker = `</${tag}`;
  if (trimmed.toLowerCase().includes(closingMarker, openingTag.index + openingTag[0].length)) return undefined;
  return Object.freeze({ kind: "raw-html", closingMarker, caseInsensitive: true });
}

export function closesMarkdownOpaqueContainer(container: MarkdownOpaqueContainer, line: string): boolean {
  return container.caseInsensitive
    ? line.toLowerCase().includes(container.closingMarker.toLowerCase())
    : line.includes(container.closingMarker);
}

export function markdownOpaqueContainerLabel(container: MarkdownOpaqueContainer): string {
  switch (container.kind) {
    case "display-math":
      return "display math";
    case "raw-html":
      return "raw HTML";
    case "raw-tex":
      return "raw TeX";
  }
}

/** Matches raw HTML even when it opens and closes on the same line. */
export function containsRawHtmlStart(line: string): boolean {
  const trimmed = stripLeadingMarkdownListMarker(line.trimStart());
  return /<[A-Za-z!/?]/u.test(trimmed);
}

function stripLeadingMarkdownListMarker(value: string): string {
  return value.replace(/^(?:[-+*]|\d{1,9}[.)])[\t ]+/u, "").trimStart();
}
