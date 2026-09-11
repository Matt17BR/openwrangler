import MarkdownIt from "markdown-it";
import { posix as posixPath } from "node:path";

const markdown = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false
});

const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const FEATURE_PARITY_HEADING = "Feature parity matrix";
const CHANGELOG_CATEGORIES = new Set(["Added", "Changed", "Fixed", "Removed", "Security"]);
const ISO_DATE = /^(?:0|[1-9]\d{3,})-(\d{2})-(\d{2})$/u;
const CHANGELOG_HEADING = /^\[([^\]\r\n]+)\] - ([^\r\n]+)$/u;
const EVIDENCE_REFERENCE = /\b(test|workflow|record):([A-Za-z0-9.][A-Za-z0-9._/-]*)(?:#[A-Za-z0-9._:-]+)?\b/gu;
const EVIDENCE_REFERENCE_PREFIX = /\b(?:test|workflow|record):/gu;
const CAPABILITY_STATUSES = new Set(["Done", "Partial", "Planned", "Out of scope"]);
const BACKEND_AVAILABILITY = new Set(["Yes", "Partial", "No"]);
function parseMarkdown(contents, label) {
  if (typeof contents !== "string" || Buffer.byteLength(contents, "utf8") > DOCUMENT_MAX_BYTES) {
    return { problem: `${label} must be bounded UTF-8 Markdown.`, tokens: undefined };
  }
  return { problem: undefined, tokens: markdown.parse(contents.replace(/\r\n?/gu, "\n"), {}) };
}

function visibleInlineText(token) {
  if (token?.type !== "inline" || !Array.isArray(token.children)) {
    return "";
  }
  return token.children
    .map((child) => {
      if (child.type === "text" || child.type === "code_inline") {
        return child.content;
      }
      if (child.type === "image") {
        return child.content;
      }
      return child.type === "softbreak" || child.type === "hardbreak" ? " " : "";
    })
    .join("");
}

function inlineText(tokens, index) {
  const token = tokens[index + 1];
  return token?.type === "inline" ? visibleInlineText(token).trim() : undefined;
}

function normalizedHeadingText(value) {
  return value
    ?.normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .trim();
}

function topLevelHeadings(tokens, tag) {
  return tokens.flatMap((token, index) =>
    token.type === "heading_open" && token.level === 0 && token.tag === tag
      ? [{ index, map: token.map, markup: token.markup, text: normalizedHeadingText(inlineText(tokens, index)) }]
      : []
  );
}

function extractTable(tokens, tableIndex) {
  const rows = [];
  let row;
  for (let index = tableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type === "table_close" && token.level === 0) {
      return rows;
    }
    if (token?.type === "tr_open") {
      row = [];
      continue;
    }
    if (token?.type === "tr_close") {
      if (row !== undefined) {
        rows.push(row);
      }
      row = undefined;
      continue;
    }
    if ((token?.type === "th_open" || token?.type === "td_open") && row !== undefined) {
      const value = tokens[index + 1];
      row.push(value?.type === "inline" ? visibleInlineText(value).trim() : "");
    }
  }
  return undefined;
}

function isPortableTrackedPath(value) {
  return (
    value === posixPath.normalize(value) &&
    !value.startsWith("/") &&
    !value.startsWith("../") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function validateEvidenceReference(kind, path, trackedEvidencePaths) {
  if (!isPortableTrackedPath(path) || !trackedEvidencePaths.has(path)) {
    return false;
  }
  if (kind === "workflow") {
    return /^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path);
  }
  if (kind === "test") {
    return (
      /^scripts\/[^/]+\.test\.mjs$/u.test(path) ||
      /^src\/test\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(path) ||
      /^python\/tests\/test_[^/]+\.py$/u.test(path)
    );
  }
  return kind === "record" && /^(?:docs\/[^/]+\.md|CHANGELOG\.md)$/u.test(path);
}

function inspectEvidence(evidence, trackedEvidencePaths) {
  const references = [...evidence.matchAll(EVIDENCE_REFERENCE)];
  const referencePrefixes = [...evidence.matchAll(EVIDENCE_REFERENCE_PREFIX)];
  if (references.length === 0 || references.length !== referencePrefixes.length) {
    return false;
  }
  return references.every((reference) => {
    const kind = reference[1];
    const path = reference[2];
    return kind !== undefined && path !== undefined && validateEvidenceReference(kind, path, trackedEvidencePaths);
  });
}

function matchingTables(tokens, expectedHeader) {
  return tokens.flatMap((token, index) => {
    if (token.type !== "table_open" || token.level !== 0) {
      return [];
    }
    const rows = extractTable(tokens, index);
    return rows?.[0]?.length === expectedHeader.length &&
      rows[0].every((cell, cellIndex) => cell === expectedHeader[cellIndex])
      ? [{ index, rows }]
      : [];
  });
}

function topLevelH2Section(tokens, heading, label) {
  const headings = topLevelHeadings(tokens, "h2");
  const matches = headings.filter((candidate) => candidate.text === heading);
  if (matches.length !== 1) {
    return {
      problem: `${label} must contain exactly one active top-level "## ${heading}" section; found ${matches.length}.`
    };
  }
  const start = matches[0].index;
  const headingInline = tokens[start + 1];
  if (
    matches[0].markup !== "##" ||
    headingInline?.type !== "inline" ||
    headingInline.content !== heading ||
    !Array.isArray(headingInline.children) ||
    headingInline.children.some((child) => child.type !== "text")
  ) {
    return {
      problem: `${label} must use one unformatted active top-level "## ${heading}" heading.`
    };
  }
  const next = headings.find((candidate) => candidate.index > start);
  return { end: next?.index ?? tokens.length, problem: undefined, start };
}

function nativeRHeadings(tokens) {
  return topLevelHeadings(tokens, "h2").filter((heading) => /^Native R\b/iu.test(heading.text ?? ""));
}

function containsActiveRawHtml(tokens, start, end) {
  for (let index = start + 1; index < end; index += 1) {
    const token = tokens[index];
    const htmlTokens = [token, ...(Array.isArray(token?.children) ? token.children : [])].filter(
      (candidate) => candidate?.type === "html_block" || candidate?.type === "html_inline"
    );
    if (htmlTokens.length > 0) {
      return true;
    }
  }
  return false;
}

function tablePrecedesNestedSections(tokens, tableIndex, sectionStart, sectionEnd) {
  const nestedHeading = tokens.findIndex(
    (token, index) =>
      index > sectionStart &&
      index < sectionEnd &&
      token.type === "heading_open" &&
      token.level === 0 &&
      token.tag !== "h2"
  );
  return nestedHeading === -1 || tableIndex < nestedHeading;
}

function tableHasDisallowedInlineMarkup(tokens, tableIndex, allowedCodeColumns = new Set()) {
  let column = -1;
  let isBodyCell = false;
  for (let index = tableIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type === "table_close" && token.level === 0) {
      return false;
    }
    if (token?.type === "tr_open") {
      column = -1;
      continue;
    }
    if (token?.type === "th_open" || token?.type === "td_open") {
      column += 1;
      isBodyCell = token.type === "td_open";
      continue;
    }
    if (
      Array.isArray(token?.children) &&
      token.children.some(
        (child) =>
          child.type !== "text" &&
          !(child.type === "code_inline" && isBodyCell && allowedCodeColumns.has(column)) &&
          child.type !== "softbreak" &&
          child.type !== "hardbreak"
      )
    ) {
      return true;
    }
  }
  return true;
}

export function inspectPreviewRParityMatrix(contents, expectedScope) {
  const parsed = parseMarkdown(contents, "docs/feature-parity.md");
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const tokens = parsed.tokens;
  const section = topLevelH2Section(tokens, "Native R preview", "docs/feature-parity.md");
  if (section.problem !== undefined || section.start === undefined || section.end === undefined) {
    return [section.problem];
  }

  const expectedHeader = ["Surface", "Availability", "Status", "Current owner"];
  if (nativeRHeadings(tokens).length !== 1) {
    return ["Preview documentation must contain Native R preview as its only active top-level Native R section."];
  }
  const sectionTables = tokens
    .map((token, index) => ({ index, token }))
    .filter(
      ({ index, token }) =>
        token.type === "table_open" && token.level === 0 && index > section.start && index < section.end
    );
  const allCanonicalTables = matchingTables(tokens, expectedHeader);
  const tables = allCanonicalTables.filter(({ index }) => index > section.start && index < section.end);
  if (
    sectionTables.length !== 1 ||
    tables.length !== 1 ||
    allCanonicalTables.length !== 1 ||
    containsActiveRawHtml(tokens, -1, tokens.length) ||
    !tablePrecedesNestedSections(tokens, tables[0]?.index ?? section.end, section.start, section.end) ||
    tableHasDisallowedInlineMarkup(tokens, tables[0]?.index ?? section.end, new Set([0]))
  ) {
    return [
      "docs/feature-parity.md must contain exactly one active top-level canonical Native R preview table inside its Native R preview section."
    ];
  }

  const problems = [];
  const rows = tables[0].rows.slice(1);
  if (rows.length !== expectedScope.length) {
    problems.push(
      `The Native R preview table must contain exactly ${expectedScope.length} rows; found ${rows.length}.`
    );
  }
  const expectedBySurface = new Map(expectedScope.map((entry) => [entry[0], entry]));
  const seen = new Set();
  for (const [index, actual] of rows.entries()) {
    if (actual.length !== expectedHeader.length) {
      problems.push(`The Native R preview table has an empty or malformed row at position ${index + 1}.`);
      continue;
    }
    const [surface, availability, status, currentOwner] = actual;
    if (seen.has(surface)) {
      problems.push(`Duplicate Native R preview row "${surface}".`);
      continue;
    }
    seen.add(surface);
    const expected = expectedBySurface.get(surface);
    if (expected === undefined) {
      problems.push(`Unexpected Native R preview row "${surface}".`);
      continue;
    }
    if (availability !== expected[1]) {
      problems.push(
        `Native R preview row "${surface}" must retain availability ${expected[1]}; received ${availability}.`
      );
    }
    if (!CAPABILITY_STATUSES.has(status)) {
      problems.push(
        `Native R preview row "${surface}" must use Done, Partial, Planned, or Out of scope; received ${status}.`
      );
    }
    if (currentOwner.length === 0) {
      problems.push(`Native R preview row "${surface}" must describe its current owner.`);
    }
  }
  for (const [surface] of expectedScope) {
    if (!seen.has(surface)) {
      problems.push(`Missing Native R preview row "${surface}".`);
    }
  }
  return problems;
}

export function inspectPrimaryParityMatrix(
  contents,
  expectedScope,
  trackedEvidencePaths,
  { requireComplete = true } = {}
) {
  const parsed = parseMarkdown(contents, "docs/feature-parity.md");
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const tokens = parsed.tokens;
  const problems = [];
  const h1 = topLevelHeadings(tokens, "h1");
  if (h1.length !== 1 || h1[0]?.index !== 0 || h1[0]?.text !== FEATURE_PARITY_HEADING) {
    problems.push('docs/feature-parity.md must begin with one active top-level "# Feature parity matrix" heading.');
  }

  const expectedHeader = ["Surface", "Pandas", "Polars", "Status", "Required evidence"];
  const tables = tokens.flatMap((token, index) => {
    if (token.type !== "table_open" || token.level !== 0) {
      return [];
    }
    const rows = extractTable(tokens, index);
    return rows?.[0]?.length === expectedHeader.length &&
      rows[0].every((cell, cellIndex) => cell === expectedHeader[cellIndex])
      ? [{ index, rows }]
      : [];
  });
  if (tables.length !== 1) {
    return [
      `docs/feature-parity.md must contain exactly one active top-level canonical Pandas/Polars parity table; found ${tables.length}.`
    ];
  }
  const table = tables[0];
  const firstH2 = topLevelHeadings(tokens, "h2")[0];
  if (firstH2 !== undefined && table.index > firstH2.index) {
    problems.push("The canonical Pandas/Polars parity table must remain in the top-level feature-parity section.");
  }

  const rows = table.rows.slice(1);
  if (rows.length !== expectedScope.length) {
    problems.push(
      `The canonical Pandas/Polars parity table must contain exactly ${expectedScope.length} release rows; found ${rows.length}.`
    );
  }
  const expectedBySurface = new Map(expectedScope.map((entry) => [entry[0], entry]));
  const seen = new Set();
  for (const [index, actual] of rows.entries()) {
    if (actual.length !== expectedHeader.length || actual.some((cell) => cell.length === 0)) {
      problems.push(`The canonical Pandas/Polars parity table has an empty or malformed row at position ${index + 1}.`);
      continue;
    }
    const [surface, pandas, polars, status, evidence] = actual;
    if (seen.has(surface)) {
      problems.push(`Duplicate parity row "${surface}".`);
      continue;
    }
    seen.add(surface);
    const expected = expectedBySurface.get(surface);
    if (expected === undefined) {
      problems.push(`Unexpected parity row "${surface}".`);
      continue;
    }
    if (requireComplete && status !== "Done") {
      problems.push(`Parity row "${surface}" is ${status}, not Done.`);
    }
    if (!requireComplete && !CAPABILITY_STATUSES.has(status)) {
      problems.push(`Parity row "${surface}" must use Done, Partial, Planned, or Out of scope; received ${status}.`);
    }
    if (!inspectEvidence(evidence, trackedEvidencePaths)) {
      problems.push(`Parity row "${surface}" must include a valid tracked test:, workflow:, or record: reference.`);
    }
    if (requireComplete && (pandas !== expected[1] || polars !== expected[2])) {
      problems.push(
        `Parity row "${surface}" must retain ${expected[1]}/${expected[2]} availability; received ${pandas}/${polars}.`
      );
    }
    if (
      !requireComplete &&
      [pandas, polars].some((availability, backend) =>
        expected[backend + 1] === "N/A" ? availability !== "N/A" : !BACKEND_AVAILABILITY.has(availability)
      )
    ) {
      problems.push(
        `Parity row "${surface}" must retain N/A for inapplicable backends and use Yes, Partial, or No for applicable backends.`
      );
    }
  }
  for (const [surface] of expectedScope) {
    if (!seen.has(surface)) {
      problems.push(`Missing parity row "${surface}".`);
    }
  }
  return problems;
}

function isCalendarDate(value) {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function substantiveListItem(tokens, start, end) {
  for (let index = start; index < end; index += 1) {
    if (tokens[index]?.type !== "list_item_open") {
      continue;
    }
    let text = "";
    for (let cursor = index + 1; cursor < end && tokens[cursor]?.type !== "list_item_close"; cursor += 1) {
      if (tokens[cursor]?.type === "inline") {
        text += ` ${visibleInlineText(tokens[cursor])}`;
      }
    }
    const normalized = text
      .replace(/[`*_~]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (normalized.length >= 12 && /[\p{L}\p{N}]/u.test(normalized)) {
      return true;
    }
  }
  return false;
}

export function inspectChangelog(contents, version) {
  const parsed = parseMarkdown(contents, "CHANGELOG.md");
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const tokens = parsed.tokens;
  const h1 = topLevelHeadings(tokens, "h1");
  if (h1.length !== 1 || h1[0]?.index !== 0 || h1[0]?.text !== "Changelog") {
    return ['CHANGELOG.md must begin with one active top-level "# Changelog" heading.'];
  }

  const matching = topLevelHeadings(tokens, "h2").filter((heading) => {
    const match = CHANGELOG_HEADING.exec(heading.text ?? "");
    return match?.[1] === version;
  });
  if (matching.length !== 1) {
    return [`CHANGELOG.md must contain exactly one active top-level heading for version ${version}.`];
  }
  const target = matching[0];
  const targetMatch = CHANGELOG_HEADING.exec(target.text ?? "");
  const date = targetMatch?.[2]?.trim() ?? "";
  if (!isCalendarDate(date)) {
    return [`CHANGELOG.md version ${version} must use a real YYYY-MM-DD release date instead of "${date}".`];
  }

  const nextH2 = topLevelHeadings(tokens, "h2").find((heading) => heading.index > target.index);
  const sectionEnd = nextH2?.index ?? tokens.length;
  const categories = topLevelHeadings(tokens.slice(target.index + 1, sectionEnd), "h3").map((heading) => ({
    ...heading,
    index: heading.index + target.index + 1
  }));
  const hasCategorizedChange = categories.some((category, categoryIndex) => {
    if (!CHANGELOG_CATEGORIES.has(category.text ?? "")) {
      return false;
    }
    const end = categories[categoryIndex + 1]?.index ?? sectionEnd;
    return substantiveListItem(tokens, category.index + 1, end);
  });
  return hasCategorizedChange
    ? []
    : [
        `CHANGELOG.md version ${version} must contain at least one substantive list item under Added, Changed, Fixed, Removed, or Security.`
      ];
}
