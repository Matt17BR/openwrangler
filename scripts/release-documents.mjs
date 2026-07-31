import MarkdownIt from "markdown-it";
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
const MARKETPLACE_URL = "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler";
const OPEN_VSX_URL = "https://open-vsx.org/extension/Matt17BR/openwrangler";
const CI_URL = "https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml";
const LICENSE_URL = "https://github.com/Matt17BR/openwrangler/blob/main/LICENSE";
const STABLE_BADGES = `<p align="center">
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
const CHANGELOG_CATEGORIES = new Set(["Added", "Changed", "Fixed", "Removed", "Security"]);
const ISO_DATE = /^(?:0|[1-9]\d{3,})-(\d{2})-(\d{2})$/u;
const CHANGELOG_HEADING = /^\[([^\]\r\n]+)\] - ([^\r\n]+)$/u;
const EVIDENCE_REFERENCE = /\b(test|workflow|record):([A-Za-z0-9.][A-Za-z0-9._/-]*)(?:#[A-Za-z0-9._:-]+)?\b/gu;
const EVIDENCE_REFERENCE_PREFIX = /\b(?:test|workflow|record):/gu;
const FUTURE_EVIDENCE =
  /\b(?:TODO|TBD|pending|planned|future|later|will (?:add|capture|record|run|test|verify)|to be (?:added|captured|recorded|run|tested|verified))\b/iu;

export const PREVIEW_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}

> **Release status:** Preview. Interfaces and behavior may change between builds.

## Install

${README_EDITOR_SUPPORT}

Build the preview VSIX from a clone:

\`\`\`bash
npm install
python3 -m venv .venv
.venv/bin/python -m pip install -e "python[dev]"
npm run package -- --pre-release --out openwrangler.vsix
\`\`\`

On Windows, use \`py -m venv .venv\` and \`.venv\\Scripts\\python.exe\` in the equivalent commands.

In the Extensions view, choose **Views and More Actions → Install from VSIX…** and select \`openwrangler.vsix\`. Open Wrangler requires VS Code 1.106 or newer and Python 3.10 through 3.14. It uses your configured or selected environment and asks before installing any missing package.

${README_RELEASE_SECTION_END}`;

export const STABLE_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}

${STABLE_BADGES}

## Install

- [Visual Studio Marketplace](${MARKETPLACE_URL})
- [Open VSX](${OPEN_VSX_URL})
- Manual or offline install from a [checksummed GitHub Release](${RELEASES_URL})

For a downloaded VSIX, open the Extensions view and choose **Views and More Actions → Install from VSIX…**.

${README_EDITOR_SUPPORT}

Open Wrangler requires VS Code 1.106 or newer and Python 3.10 through 3.14. It uses your configured Python path, selected environment, or a supported system interpreter. Missing packages are listed before the extension offers an explicit, confirm-before-install action.

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
      return child.type === "softbreak" || child.type === "hardbreak" ? " " : "";
    })
    .join("");
}

function inlineText(tokens, index) {
  const token = tokens[index + 1];
  return token?.type === "inline" ? visibleInlineText(token).trim() : undefined;
}

function topLevelHeadings(tokens, tag) {
  return tokens.flatMap((token, index) =>
    token.type === "heading_open" && token.level === 0 && token.tag === tag
      ? [{ index, map: token.map, text: inlineText(tokens, index) }]
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

export function inspectStableReadme(contents, label = "README.md") {
  return inspectReadmeReleaseRegion(contents, label, STABLE_README_RELEASE_SECTION, "stable");
}

export function inspectPerformanceEvidenceReadme(contents, label = "README.md") {
  return inspectReadmeReleaseRegion(
    contents,
    label,
    PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
    "performance-evidence candidate"
  );
}
