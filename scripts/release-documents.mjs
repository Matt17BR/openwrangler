import MarkdownIt from "markdown-it";
import { JSDOM } from "jsdom";
import { posix as posixPath } from "node:path";

const markdown = new MarkdownIt({
  html: true,
  linkify: false,
  typographer: false
});

const DOCUMENT_MAX_BYTES = 2 * 1024 * 1024;
const FEATURE_PARITY_HEADING = "Feature parity matrix";
const README_RELEASE_SECTION_START = "<!-- open-wrangler-release-status:start -->";
const README_RELEASE_SECTION_END = "<!-- open-wrangler-release-status:end -->";
const RELEASES_URL = "https://github.com/Matt17BR/openwrangler/releases";
const LATEST_STABLE_RELEASE_URL = "https://github.com/Matt17BR/openwrangler/releases/latest";
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler";
const OPEN_VSX_URL = "https://open-vsx.org/extension/Matt17BR/openwrangler";
const CI_URL = "https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml";
const LICENSE_URL = "https://github.com/Matt17BR/openwrangler/blob/main/LICENSE";
const README_BADGES = `<p align="center">
  <a href="${RELEASES_URL}"><img src="https://img.shields.io/github/v/release/Matt17BR/openwrangler?display_name=tag&amp;sort=semver" alt="Latest GitHub release"></a>
  <a href="${CI_URL}"><img src="https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="${MARKETPLACE_URL}"><img src="https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg" alt="Visual Studio Marketplace version"></a>
  <a href="${OPEN_VSX_URL}"><img src="https://img.shields.io/open-vsx/v/Matt17BR/openwrangler?label=Open%20VSX" alt="Open VSX version"></a>
  <a href="${LICENSE_URL}"><img src="https://img.shields.io/github/license/Matt17BR/openwrangler" alt="MIT license"></a>
</p>`;
const README_EDITOR_SUPPORT = `| Editor                      | Support        |
| --------------------------- | -------------- |
| VS Code                     | Release-tested |
| Cursor                      | Release-tested |
| Other VS Code desktop forks | Experimental   |
| Browser-hosted \`vscode.dev\` | Unsupported    |`;
const README_RUNTIME_REQUIREMENTS = `Open Wrangler requires VS Code 1.106 or newer. File sources and Python notebook dataframes use Python 3.10 through
3.14 from your configured path, selected environment, or a supported system interpreter. If a required Python package
is missing, Open Wrangler lists it and asks before installing anything.

R support uses the environment that owns the dataframe: the selected IRkernel for a notebook, the selected official
VS Code R terminal for an interactive session, or the \`Rscript\` chosen by \`openWrangler.rscriptPath\` or \`PATH\` for
a trusted \`.R\`, \`.Rmd\`, or \`.qmd\` document. Install \`jsonlite\` and \`rlang\` in that same environment. Parquet
export also needs \`nanoparquet\` 0.5.1 or newer there; CSV export does not. R notebooks remain available on Windows,
but direct R-document execution is currently limited to macOS and Linux.`;
const README_TRUST_REQUIREMENT =
  "Opening data or using a notebook kernel requires a trusted workspace. Open Wrangler stays inactive in Restricted Mode.";
const README_INSTALL_TRACKS = `- **Latest stable:** choose **Install** on the [Visual Studio Marketplace](${MARKETPLACE_URL}), choose the newest
  stable version from [Open VSX](${OPEN_VSX_URL})'s version list, or download the [latest stable GitHub Release](${LATEST_STABLE_RELEASE_URL}).
- **Latest preview:** choose **Install Pre-Release Version** on the editor listing. Other Open VSX clients may label
  this differently; select the newest \`1.99.x\` version. The same VSIX is available from [GitHub prereleases](${RELEASES_URL}).
- **Current \`main\`:** build the latest source below. It may be ahead of the published preview.`;
const README_SOURCE_BUILD = `To build and install the current \`main\` branch:

\`\`\`bash
git clone --depth 1 --branch main https://github.com/Matt17BR/openwrangler.git
cd openwrangler
npm ci --ignore-scripts
npm run package:dev
\`\`\`

The shallow clone retains \`.git\` for package source guards without downloading repository history or release tags.

Then run \`code --install-extension openwrangler-dev.vsix --force\` or
\`cursor --install-extension openwrangler-dev.vsix --force\`.`;
const CHANGELOG_CATEGORIES = new Set(["Added", "Changed", "Fixed", "Removed", "Security"]);
const ISO_DATE = /^(?:0|[1-9]\d{3,})-(\d{2})-(\d{2})$/u;
const CHANGELOG_HEADING = /^\[([^\]\r\n]+)\] - ([^\r\n]+)$/u;
const EVIDENCE_REFERENCE = /\b(test|workflow|record):([A-Za-z0-9.][A-Za-z0-9._/-]*)(?:#[A-Za-z0-9._:-]+)?\b/gu;
const EVIDENCE_REFERENCE_PREFIX = /\b(?:test|workflow|record):/gu;
const STABLE_R_EVIDENCE_REFERENCE =
  /\b(test|workflow|record):([A-Za-z0-9.][A-Za-z0-9._/-]*)(?:#[A-Za-z0-9._:-]+)?(?=$|[\s;,)\]])/gu;
const FUTURE_EVIDENCE =
  /\b(?:TODO|TBD|pending|planned|future|later|will (?:add|capture|record|run|test|verify)|to be (?:added|captured|recorded|run|tested|verified))\b/iu;
const STABLE_R_COMPLETION_TEXT = "Exact stable acceptance passed and is recorded";
const LEGACY_PREVIEW_VERSION = /(?<![\d.])v?1\.99(?:\.(?:x|\d+))?(?:(?=previews?\b)|(?![\p{L}\p{N}]|\.[\p{L}\p{N}]))/iu;

function containsUnsupportedTextControl(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      (codePoint >= 0 && codePoint <= 8) ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31) ||
      (codePoint >= 127 && codePoint <= 159)
    );
  });
}

export const PREVIEW_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}

${README_BADGES}

> Open Wrangler 1.99 previews version 2. Features and behavior may still change.

## Install

${README_EDITOR_SUPPORT}

${README_INSTALL_TRACKS}

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

${README_SOURCE_BUILD}

${README_RUNTIME_REQUIREMENTS}

${README_TRUST_REQUIREMENT}

${README_RELEASE_SECTION_END}`;

export const STABLE_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}

${README_BADGES}

## Install

${README_INSTALL_TRACKS}

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

${README_SOURCE_BUILD}

${README_EDITOR_SUPPORT}

${README_RUNTIME_REQUIREMENTS}

${README_TRUST_REQUIREMENT}

${README_RELEASE_SECTION_END}`;

export const PERFORMANCE_EVIDENCE_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}

> **Release status:** Validation candidate. This build is not for distribution.

## Install

${README_EDITOR_SUPPORT}

This candidate is installed only by the isolated validation workflow. Use a stable release for normal installation.

${README_RELEASE_SECTION_END}`;

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

function rawTableCellMarkdown(contents, tableStartLine, rowIndex, columnIndex) {
  const line = contents.replace(/\r\n?/gu, "\n").split("\n")[tableStartLine + 2 + rowIndex];
  if (line === undefined) {
    return undefined;
  }
  const cells = line
    .split(/(?<!\\)\|/u)
    .slice(1, -1)
    .map((cell) => cell.trim());
  return cells[columnIndex];
}

function previewSurfaceMarkdown(surface) {
  const replacements = new Map([
    ["Base data.frame, tibble, and data.table", "Base `data.frame`, tibble, and `data.table`"],
    ["Cursor-owned .Rmd and .qmd R/Python chunk", "Cursor-owned `.Rmd` and `.qmd` R/Python chunk"],
    ["Owned .R source process", "Owned `.R` source process"],
    ["Owned .Rmd and .qmd cell process", "Owned `.Rmd` and `.qmd` cell process"],
    ["Insert generated R into its source .R file", "Insert generated R into its source `.R` file"],
    ["Insert generated R into .Rmd and .qmd", "Insert generated R into `.Rmd` and `.qmd`"]
  ]);
  return replacements.get(surface) ?? surface;
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
  const humanText = evidence
    .replace(EVIDENCE_REFERENCE, "")
    .replace(/[`*_~()[\]\u2014\u2013:;,.]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (humanText.length < 8 || !/[\p{L}\p{N}]/u.test(humanText) || FUTURE_EVIDENCE.test(humanText)) {
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

function sectionContainsOnlyCanonicalTable(tokens, sectionStart, sectionEnd, tableIndex) {
  const tableEnd = tokens.findIndex(
    (token, index) => index > tableIndex && index < sectionEnd && token.type === "table_close" && token.level === 0
  );
  return tableIndex === sectionStart + 3 && tableEnd === sectionEnd - 1;
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

function stableREvidenceHumanText(evidence) {
  return evidence
    .replace(STABLE_R_EVIDENCE_REFERENCE, "")
    .replace(/[`*_~()[\]\u2014\u2013:;,.]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function inspectExactRStableEvidence(evidence, expectedReferences, trackedEvidencePaths) {
  const references = [...evidence.matchAll(STABLE_R_EVIDENCE_REFERENCE)];
  const referencePrefixes = [...evidence.matchAll(EVIDENCE_REFERENCE_PREFIX)];
  if (
    references.length === 0 ||
    references.length !== referencePrefixes.length ||
    stableREvidenceHumanText(evidence) !== STABLE_R_COMPLETION_TEXT
  ) {
    return false;
  }
  const actual = references.map((reference) => reference[0]).sort();
  const expected = [...expectedReferences].sort();
  if (
    actual.length !== expected.length ||
    actual.some((reference, index) => reference !== expected[index]) ||
    new Set(actual).size !== actual.length
  ) {
    return false;
  }
  return references.every((reference) => {
    const path = reference[2];
    return path !== undefined && trackedEvidencePaths.has(path) && isPortableTrackedPath(path);
  });
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

  const expectedHeader = ["Surface", "Availability", "Status", "Current checks", "Release check"];
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
      `The Native R preview table must contain exactly ${expectedScope.length} ordered rows; found ${rows.length}.`
    );
  }
  const comparisonLength = Math.max(rows.length, expectedScope.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    const actual = rows[index];
    const expected = expectedScope[index];
    if (expected === undefined) {
      problems.push(`Unexpected Native R preview row "${actual?.[0] ?? ""}" at position ${index + 1}.`);
      continue;
    }
    if (actual === undefined) {
      problems.push(`Missing Native R preview row "${expected[0]}" at position ${index + 1}.`);
      continue;
    }
    if (actual.length !== expectedHeader.length || actual.some((cell) => cell.length === 0)) {
      problems.push(`The Native R preview table has an empty or malformed row at position ${index + 1}.`);
      continue;
    }
    const [surface, availability, status, currentChecks, releaseCheck] = actual;
    const rawSurface = rawTableCellMarkdown(contents, tokens[tables[0].index]?.map?.[0] ?? -1, index, 0);
    if (surface !== expected[0] || availability !== expected[1] || releaseCheck !== "Preview release") {
      problems.push(`Native R preview row ${index + 1} must be "${expected[0]}" (${expected[1]}/Preview release).`);
    }
    if (status !== expected[2]) {
      problems.push(`Native R preview row "${surface}" must remain ${expected[2]}; received ${status}.`);
    }
    if (status === "Done" && currentChecks !== expected[3]) {
      problems.push(`Native R preview row "${surface}" must retain its exact reviewed completion evidence.`);
    }
    if (rawSurface !== previewSurfaceMarkdown(expected[0])) {
      problems.push(`Native R preview row "${surface}" must retain its exact reviewed surface markup.`);
    }
    if (
      currentChecks.length < 8 ||
      !/[\p{L}\p{N}]/u.test(currentChecks) ||
      (status === "Done" && FUTURE_EVIDENCE.test(currentChecks))
    ) {
      problems.push(`Native R preview row "${surface}" must describe its current checks.`);
    }
  }
  return problems;
}

export function inspectStableRParityMatrix(contents, expectedScope, trackedEvidencePaths) {
  if (!(trackedEvidencePaths instanceof Set)) {
    return ["Stable Native R evidence paths must be supplied as one tracked-path set."];
  }
  const parsed = parseMarkdown(contents, "docs/feature-parity.md");
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const tokens = parsed.tokens;
  if (tokens.some((token) => Array.isArray(token.children) && token.children.some((child) => child.type === "image"))) {
    return ["Stable feature-parity documentation must not contain active images."];
  }
  const activeInlineText = tokens
    .filter((token) => token.type === "inline")
    .map((token) => visibleInlineText(token))
    .join(" ");
  if (containsUnsupportedTextControl(activeInlineText)) {
    return ["Stable feature-parity documentation must not contain unsupported control characters."];
  }
  if (/\p{Bidi_Control}/u.test(activeInlineText)) {
    return ["Stable feature-parity documentation must not contain bidirectional text controls."];
  }
  if (/\p{Cf}/u.test(activeInlineText)) {
    return ["Stable feature-parity documentation must not contain Unicode format characters."];
  }
  if (/\p{Default_Ignorable_Code_Point}/u.test(activeInlineText)) {
    return ["Stable feature-parity documentation must not contain default-ignorable text characters."];
  }
  const documentVisibleText = activeInlineText
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/\s+/gu, " ");
  if (
    LEGACY_PREVIEW_VERSION.test(documentVisibleText) ||
    /\b(?:other cleaning operations are not available in R yet|before a 2\.0 tag can be published|Open Wrangler 2\.0 previews?)\b/iu.test(
      documentVisibleText
    )
  ) {
    return ["Stable feature-parity documentation must not contain active preview-era Native R copy."];
  }
  const section = topLevelH2Section(tokens, "Native R support", "docs/feature-parity.md");
  if (section.problem !== undefined || section.start === undefined || section.end === undefined) {
    return [section.problem];
  }

  const expectedHeader = ["Surface", "Availability", "Status", "Required evidence", "Release gate"];
  if (nativeRHeadings(tokens).length !== 1) {
    return ["Stable documentation must contain Native R support as its only active top-level Native R section."];
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
    !sectionContainsOnlyCanonicalTable(tokens, section.start, section.end, tables[0]?.index ?? section.end) ||
    !tablePrecedesNestedSections(tokens, tables[0]?.index ?? section.end, section.start, section.end) ||
    tableHasDisallowedInlineMarkup(tokens, tables[0]?.index ?? section.end)
  ) {
    return [
      "docs/feature-parity.md must contain exactly one active top-level canonical stable Native R table inside its Native R support section."
    ];
  }

  const problems = [];
  const rows = tables[0].rows.slice(1);
  if (rows.length !== expectedScope.length) {
    problems.push(
      `The stable Native R table must contain exactly ${expectedScope.length} ordered release rows; found ${rows.length}.`
    );
  }
  const comparisonLength = Math.max(rows.length, expectedScope.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    const actual = rows[index];
    const expected = expectedScope[index];
    if (expected === undefined) {
      problems.push(`Unexpected stable Native R row "${actual?.[0] ?? ""}" at position ${index + 1}.`);
      continue;
    }
    if (actual === undefined) {
      problems.push(`Missing stable Native R row "${expected.surface}" at position ${index + 1}.`);
      continue;
    }
    if (actual.length !== expectedHeader.length || actual.some((cell) => cell.length === 0)) {
      problems.push(`The stable Native R table has an empty or malformed row at position ${index + 1}.`);
      continue;
    }
    const [surface, availability, status, evidence, releaseGate] = actual;
    const rawSurface = rawTableCellMarkdown(contents, tokens[tables[0].index]?.map?.[0] ?? -1, index, 0);
    if (surface !== expected.surface || availability !== expected.availability || releaseGate !== "Stable release") {
      problems.push(
        `Stable Native R row ${index + 1} must be "${expected.surface}" (${expected.availability}/Stable release).`
      );
    }
    if (rawSurface !== expected.surface) {
      problems.push(`Stable Native R row "${surface}" must retain its exact reviewed surface markup.`);
    }
    if (status !== "Done") {
      problems.push(`Stable Native R row "${surface}" is ${status}, not Done.`);
    } else if (!inspectExactRStableEvidence(evidence, expected.evidence, trackedEvidencePaths)) {
      problems.push(
        `Stable Native R row "${surface}" must say "${STABLE_R_COMPLETION_TEXT}" and contain exactly its reviewed tracked evidence references.`
      );
    }
  }
  return problems;
}

export function inspectPrimaryParityMatrix(
  contents,
  expectedScope,
  trackedEvidencePaths,
  allowedIncompleteRows = new Map(),
  requiredIncompleteRows = new Map()
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
  const comparisonLength = Math.max(rows.length, expectedScope.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    const actual = rows[index];
    const expected = expectedScope[index];
    if (expected === undefined) {
      problems.push(`Unexpected parity row "${actual?.[0] ?? ""}" at position ${index + 1}.`);
      continue;
    }
    if (actual === undefined) {
      problems.push(`Missing parity row "${expected[0]}" at position ${index + 1}.`);
      continue;
    }
    if (actual.length !== expectedHeader.length || actual.some((cell) => cell.length === 0)) {
      problems.push(`The canonical Pandas/Polars parity table has an empty or malformed row at position ${index + 1}.`);
      continue;
    }

    const [surface, pandas, polars, status, evidence] = actual;
    const allowedIncompleteStatus = allowedIncompleteRows.get(surface);
    const requiredIncompleteStatus = requiredIncompleteRows.get(surface);
    if (status !== "Done" && status !== allowedIncompleteStatus) {
      problems.push(`Parity row "${surface}" is ${status}, not Done.`);
    } else if (requiredIncompleteStatus !== undefined && status !== requiredIncompleteStatus) {
      problems.push(
        `Parity row "${surface}" must remain ${requiredIncompleteStatus} while authoring performance evidence; received ${status}.`
      );
    } else if (!inspectEvidence(evidence, trackedEvidencePaths)) {
      problems.push(
        `Parity row "${surface}" must record acceptance progress plus a valid tracked test:, workflow:, or record: reference.`
      );
    }
    if (surface !== expected[0] || pandas !== expected[1] || polars !== expected[2]) {
      problems.push(
        `Parity row ${index + 1} must be "${expected[0]}" (${expected[1]}/${expected[2]}), received "${surface}" (${pandas}/${polars}).`
      );
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

function lineRangeContains(range, token) {
  return (
    range !== undefined &&
    token.map !== null &&
    token.map !== undefined &&
    token.map[0] >= range[0] &&
    token.map[1] <= range[1]
  );
}

function isProductReleaseClaim(value) {
  const normalized = value
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (
    /\bprebuilt (?:Open Wrangler )?releases? (?:are|remain|will be)\b/iu.test(normalized) ||
    /\bno (?:prebuilt|packaged|stable) (?:Open Wrangler )?releases? (?:are|remain|will be)?\b/iu.test(normalized) ||
    /\bfuture (?:Open Wrangler )?preview builds?\b/iu.test(normalized) ||
    /\bOpen Wrangler(?: itself)? (?:is|remains) (?:an? )?(?:preview|stable|released|published)\b/iu.test(normalized) ||
    /\bThis is (?:an? )?preview\b.*\b(?:Open Wrangler|Data Wrangler|parity)\b/iu.test(normalized) ||
    /\bThis is\b.*\bnot\b.*\bparity[- ]complete\b/iu.test(normalized) ||
    /\bOpen Wrangler\b.*\b(?:has|satisfies|reaches|claims)\b.*\b(?:complete )?parity\b/iu.test(normalized) ||
    /\bOpen Wrangler\b.*\b(?:not yet|does not yet|is not)\b.*\b(?:parity|stable|published)\b/iu.test(normalized)
  );
}

function inspectReadmeReleaseRegion(contents, label, expectedSection, channel) {
  const normalized = typeof contents === "string" ? contents.replace(/\r\n?/gu, "\n") : contents;
  const parsed = parseMarkdown(normalized, label);
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const tokens = parsed.tokens;
  const marker = (value) =>
    tokens.flatMap((token, index) =>
      token.type === "html_block" && token.level === 0 && token.content.trim() === value
        ? [{ index, map: token.map }]
        : []
    );
  const starts = marker(README_RELEASE_SECTION_START);
  const ends = marker(README_RELEASE_SECTION_END);
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) {
    return [`${label} must contain one active top-level generated ${channel} release/install region.`];
  }
  const range = [starts[0].map?.[0] ?? -1, ends[0].map?.[1] ?? -1];
  const lines = normalized.split("\n");
  const actual = lines.slice(range[0], range[1]).join("\n");
  if (actual !== expectedSection) {
    return [`${label} must contain the exact generated ${channel} release/install region.`];
  }

  const installHeadings = topLevelHeadings(tokens, "h2").filter((heading) => heading.text === "Install");
  if (installHeadings.length !== 1 || !lineRangeContains(range, tokens[installHeadings[0].index])) {
    return [`${label} must keep its only active Install section inside the generated ${channel} region.`];
  }
  for (const token of tokens) {
    if (lineRangeContains(range, token)) {
      continue;
    }
    const isVisibleText = token.type === "inline" || (token.type === "html_block" && !token.content.startsWith("<!--"));
    const visibleText = token.type === "inline" ? visibleInlineText(token) : token.content;
    const hasReleaseStatus = isVisibleText && /^\s*\**Release status:\**/iu.test(visibleText);
    const hasReleaseLink =
      token.type === "inline" &&
      token.children?.some((child) => child.type === "link_open" && child.attrGet("href") === RELEASES_URL);
    if (hasReleaseStatus || hasReleaseLink || (isVisibleText && isProductReleaseClaim(visibleText))) {
      return [`${label} contains release-channel status or install material outside its generated region.`];
    }
  }
  return [];
}

export function inspectPreviewReadme(contents, label = "README.md") {
  return inspectReadmeReleaseRegion(contents, label, PREVIEW_README_RELEASE_SECTION, "preview");
}

export function inspectStablePublicCopy(contents, label = "Public documentation") {
  const parsed = parseMarkdown(contents, label);
  if (parsed.problem !== undefined || parsed.tokens === undefined) {
    return [parsed.problem];
  }
  const rendered = markdown.renderer.render(
    parsed.tokens.filter((token) => token.type !== "fence" && token.type !== "code_block"),
    markdown.options,
    {}
  );
  const fragment = JSDOM.fragment(rendered);
  const allowedElements = new Map([
    ["A", new Set(["href"])],
    ["BLOCKQUOTE", new Set()],
    ["CODE", new Set()],
    ["EM", new Set()],
    ["H1", new Set(["align"])],
    ["H2", new Set()],
    ["IMG", new Set(["alt", "height", "src", "width"])],
    ["LI", new Set()],
    ["P", new Set(["align"])],
    ["STRONG", new Set()],
    ["TABLE", new Set()],
    ["TBODY", new Set()],
    ["TD", new Set(["width"])],
    ["TH", new Set()],
    ["THEAD", new Set()],
    ["TR", new Set()],
    ["UL", new Set()]
  ]);
  const unsupportedElement = [...fragment.querySelectorAll("*")].find((element) => {
    const allowedAttributes = allowedElements.get(element.tagName);
    return (
      allowedAttributes === undefined ||
      [...element.attributes].some((attribute) => !allowedAttributes.has(attribute.name))
    );
  });
  if (unsupportedElement !== undefined) {
    return [`${label} contains unsupported active HTML that can obscure its stable release copy.`];
  }
  const blockElements = new Set([
    "BLOCKQUOTE",
    "H1",
    "H2",
    "LI",
    "P",
    "TABLE",
    "TBODY",
    "TD",
    "TH",
    "THEAD",
    "TR",
    "UL"
  ]);
  const renderedText = (node, includeImageAlt) => {
    if (node.nodeType === 3) {
      return node.nodeValue ?? "";
    }
    if (node.nodeType !== 1 && node.nodeType !== 11) {
      return "";
    }
    if (node.nodeType === 1 && node.nodeName === "IMG") {
      return includeImageAlt ? (node.getAttribute("alt") ?? "") : "";
    }
    const text = [...node.childNodes].map((child) => renderedText(child, includeImageAlt)).join("");
    return node.nodeType === 1 && blockElements.has(node.nodeName) ? `${text}\n` : text;
  };
  const renderedTexts = [true, false].map((includeImageAlt) => renderedText(fragment, includeImageAlt));
  if (renderedTexts.some((renderedCopy) => containsUnsupportedTextControl(renderedCopy))) {
    return [`${label} contains unsupported control characters in its stable release copy.`];
  }
  if (renderedTexts.some((renderedCopy) => /\p{Bidi_Control}/u.test(renderedCopy))) {
    return [`${label} contains unsupported bidirectional text controls in its stable release copy.`];
  }
  if (renderedTexts.some((renderedCopy) => /\p{Cf}/u.test(renderedCopy))) {
    return [`${label} contains unsupported Unicode format characters in its stable release copy.`];
  }
  if (renderedTexts.some((renderedCopy) => /\p{Default_Ignorable_Code_Point}/u.test(renderedCopy))) {
    return [`${label} contains unsupported default-ignorable characters in its stable release copy.`];
  }
  const visibleTexts = renderedTexts.map((renderedCopy) =>
    renderedCopy
      .normalize("NFKC")
      .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
      .replace(/\s+/gu, " ")
  );
  return visibleTexts.some((visibleText) => LEGACY_PREVIEW_VERSION.test(visibleText))
    ? [`${label} still contains a 1.99 preview label. Remove it before the stable version 2 release.`]
    : [];
}

export function inspectStableReadme(contents, label = "README.md") {
  const normalizedContents = typeof contents === "string" ? contents.replace(/\r\n?/gu, "\n") : contents;
  const releaseRegionProblems = inspectReadmeReleaseRegion(
    normalizedContents,
    label,
    STABLE_README_RELEASE_SECTION,
    "stable"
  );
  if (typeof normalizedContents !== "string") {
    return releaseRegionProblems;
  }
  return [
    ...releaseRegionProblems,
    ...inspectStablePublicCopy(normalizedContents.replace(STABLE_README_RELEASE_SECTION, ""), label)
  ];
}

export function inspectPerformanceEvidenceReadme(contents, label = "README.md") {
  return inspectReadmeReleaseRegion(
    contents,
    label,
    PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
    "performance-evidence candidate"
  );
}
