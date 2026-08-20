import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { SaxesParser } from "saxes";
import {
  DATA_WRANGLER_STUDY_REPORT_MAX_BYTES,
  assertReleaseCompleteStudyReport
} from "./data-wrangler-comparison-report.mjs";
import {
  inspectChangelog,
  inspectPerformanceEvidenceReadme,
  inspectPreviewReadme,
  inspectPreviewRParityMatrix,
  inspectPrimaryParityMatrix,
  inspectStableRParityMatrix,
  inspectStableReadme,
  PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
  STABLE_README_RELEASE_SECTION
} from "./release-documents.mjs";
import { classifyNumericReleaseVersion, NUMERIC_RELEASE_VERSION } from "./release-metadata.mjs";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const VSIX_MANIFEST_NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const PYTHON_VERSION = /^__version__\s*=\s*"([^"\r\n]+)"\s*$/gmu;
const FULL_COMMIT_ID = /^[0-9a-f]{40}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SOURCE_FILES = new Map([
  ["package.json", 1024 * 1024],
  ["python/openwrangler_runtime/version.py", 64 * 1024],
  ["docs/feature-parity.md", 2 * 1024 * 1024],
  ["CHANGELOG.md", 2 * 1024 * 1024],
  ["README.md", 2 * 1024 * 1024]
]);
export { PERFORMANCE_EVIDENCE_README_RELEASE_SECTION, STABLE_README_RELEASE_SECTION };
const STABLE_PACKAGE_IDENTITY = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR"
});
export const PRIMARY_PARITY_SCOPE = Object.freeze([
  ["CSV/TSV/Parquet/Excel/JSONL entry points", "Yes", "Yes"],
  ["Notebook variable viewer and toolbar", "Yes", "Yes"],
  ["Inline notebook renderer and full-view expansion", "Yes", "Yes"],
  ["Virtual grid, column sizing, navigation", "Yes", "Yes"],
  ["Dataset summary and quick insights", "Yes", "Yes"],
  ["Basic and advanced viewing filters", "Yes", "Yes"],
  ["Multi-column viewing sorts", "Yes", "Yes"],
  ["Editing mode and operation catalog", "Yes", "Yes"],
  ["Draft preview and data diff", "Yes", "Yes"],
  ["Cleaning-step history, edit, discard, undo", "Yes", "Yes"],
  ["Generated code preview and editing", "Yes", "Yes"],
  ["Sort/filter cleaning steps", "Yes", "Yes"],
  ["Select/drop/rename/clone/cast/formula/length", "Yes", "Yes"],
  ["Drop missing/duplicate rows", "Yes", "Yes"],
  ["Fill missing values", "Yes", "Yes"],
  ["One-hot and multi-label binarization", "Yes", "Yes"],
  ["Find/replace/strip/split/case transforms", "Yes", "Yes"],
  ["Scale/round/floor/ceiling/datetime format", "Yes", "Yes"],
  ["Group and aggregate", "Yes", "Yes"],
  ["Custom engine-native code", "Yes", "Yes"],
  ["String/datetime/new-column by example", "Yes", "Yes"],
  ["Copy/script/notebook code export", "Yes", "Yes"],
  ["CSV and Parquet data export", "Yes", "Yes"],
  ["Runtime selection, setup, change, clear", "Yes", "Yes"],
  ["Original icons, native views, themes, accessibility", "N/A", "N/A"],
  ["Runtime crash/reload/session replay", "Yes", "Yes"],
  ["Column-projected grid-block transport", "Yes", "Yes"],
  ["Duplicate/non-string Pandas column operations", "Yes", "N/A"],
  ["Restricted Mode and trust-gated execution", "N/A", "N/A"],
  ["Installed-editor first-usable-grid performance", "Yes", "Yes"],
  ["Cross-platform first-class editor package acceptance", "N/A", "N/A"]
]);
function previewRScope(...values) {
  if (
    (values.length !== 3 && values.length !== 4) ||
    values.some((value) => typeof value !== "string" || value.length === 0) ||
    (values[2] === "Done") !== (values.length === 4)
  ) {
    throw new Error("Every Native R preview scope entry requires exact status-bound reviewed evidence.");
  }
  return Object.freeze(values);
}

export const R_PREVIEW_PARITY_SCOPE = Object.freeze([
  previewRScope("Native R frame paging and typed cells", "1.99 preview", "Partial"),
  previewRScope("Native R compound viewing filters", "1.99 preview", "Partial"),
  previewRScope("Native R value search and selections", "1.99 preview", "Partial"),
  previewRScope("Native R ordered viewing sorts", "1.99 preview", "Partial"),
  previewRScope("Native R column and dataset profiles", "1.99 preview", "Partial"),
  previewRScope("Base data.frame, tibble, and data.table", "1.99 preview", "Partial"),
  previewRScope(
    "Exact IRkernel session transport",
    "1.99 preview",
    "Done",
    "Linux local VS Code/Cursor and remote VS Code; macOS/Windows VS Code gate"
  ),
  previewRScope("Exact active R-terminal transport", "1.99 preview", "Partial"),
  previewRScope("Cursor-owned .Rmd and .qmd R/Python chunk", "1.99 preview", "Partial"),
  previewRScope("Owned .R source process", "1.99 preview", "Partial"),
  previewRScope("Owned .Rmd and .qmd cell process", "1.99 preview", "Partial"),
  previewRScope("Notebook workbench", "1.99 preview", "Partial"),
  previewRScope("R cleaning operations and generated code", "28 operations", "Partial"),
  previewRScope("Copy or save generated R", "28 operations", "Partial"),
  previewRScope("Insert generated R into its IRkernel notebook", "1.99 preview", "Partial"),
  previewRScope("Insert generated R into its source .R file", "1.99 preview", "Partial"),
  previewRScope("Insert generated R into .Rmd and .qmd", "1.99 preview", "Partial"),
  previewRScope("Cleaned-data export", "R notebook/document CSV/Parquet", "Partial"),
  previewRScope("Active R-terminal cleaned-data export", "1.99 preview", "Partial"),
  previewRScope("Quarto and R Markdown lexical R-cell run", "1.99 preview", "Partial")
]);

const R_STABLE_COMMON_EVIDENCE = Object.freeze([
  "test:src/test/extensionHost/index.ts",
  "workflow:.github/workflows/candidate-acceptance.yml",
  "record:docs/testing.md"
]);

function stableRScope(...values) {
  if (values.length !== 3 || values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new Error("Every stable Native R scope entry requires exactly one surface, availability, and row test.");
  }
  const [surface, availability, rowTest] = values;
  return Object.freeze({
    availability,
    evidence: Object.freeze([`test:${rowTest}`, ...R_STABLE_COMMON_EVIDENCE]),
    surface
  });
}

export const R_STABLE_PARITY_SCOPE = Object.freeze([
  stableRScope("Native R frame paging and typed cells", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope("Native R compound viewing filters", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope("Native R value search and selections", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope("Native R ordered viewing sorts", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope("Native R column and dataset profiles", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope("Base data.frame, tibble, and data.table", "All supported R sessions", "r/tests/frame_contract.R"),
  stableRScope(
    "Ordinary collapse::qDF(), collapse::qTBL(), and collapse::qDT() frames",
    "All supported R sessions",
    "r/tests/frame_contract.R"
  ),
  stableRScope(
    "Exact IRkernel session transport",
    "Linux, macOS, and Windows",
    "src/test/rKernelTransport.cross.test.ts"
  ),
  stableRScope("Exact active R-terminal transport", "Linux", "src/test/rInteractiveSessionTransport.cross.test.ts"),
  stableRScope(
    "Cursor .Rmd document command and .qmd R/Python chunk actions",
    "Linux",
    "src/test/rDocumentCommands.unit.test.ts"
  ),
  stableRScope("Owned .R source process", "Linux and macOS", "src/test/rProcessTransport.cross.test.ts"),
  stableRScope("Owned .Rmd and .qmd cell process", "Linux and macOS", "src/test/literateDocumentChunks.unit.test.ts"),
  stableRScope("Notebook workbench", "Linux, macOS, and Windows", "src/test/rKernelBridge.unit.test.ts"),
  stableRScope(
    "Complete R cleaning catalog and generated code",
    "All 32 catalog operations",
    "r/tests/complete_catalog_contract.R"
  ),
  stableRScope(
    "Copy or save generated R",
    "All 32 catalog operations",
    "src/test/rCompleteCatalogCodeExport.unit.test.ts"
  ),
  stableRScope(
    "Insert generated R into its IRkernel notebook",
    "Linux, macOS, and Windows",
    "src/test/notebookInsertion.unit.test.ts"
  ),
  stableRScope(
    "Insert generated R into its source .R file",
    "Linux and macOS",
    "src/test/rDocumentInsertion.unit.test.ts"
  ),
  stableRScope("Insert generated R into .Rmd and .qmd", "Linux and macOS", "src/test/rDocumentInsertion.unit.test.ts"),
  stableRScope("Cleaned-data export", "CSV and Parquet", "r/tests/frame_contract.R"),
  stableRScope("Active R-terminal cleaned-data export", "Linux", "src/test/rInteractiveExport.unit.test.ts"),
  stableRScope(
    "Quarto and R Markdown lexical R-cell run",
    "Linux and macOS",
    "src/test/literateDocumentChunks.unit.test.ts"
  ),
  stableRScope("Native R performance record", "Release candidate", "scripts/r-performance-report.test.mjs"),
  stableRScope(
    "First-class editor candidate acceptance",
    "VS Code and Cursor",
    "scripts/candidate-acceptance-workflow.test.mjs"
  )
]);
export const PERFORMANCE_EVIDENCE_PARTIAL_ROWS = Object.freeze([
  "Virtual grid, column sizing, navigation",
  "Installed-editor first-usable-grid performance"
]);
export const PERFORMANCE_EVIDENCE_VERSION = "1.0.0";
const PERFORMANCE_EVIDENCE_ALLOWED_INCOMPLETE_ROWS = new Map(
  PERFORMANCE_EVIDENCE_PARTIAL_ROWS.map((surface) => [surface, "Partial"])
);
const PERFORMANCE_REPORT_LINK =
  /\[[^\]\r\n]+\]\(https:\/\/github\.com\/Matt17BR\/openwrangler\/blob\/main\/(?<path>docs\/performance\/data-wrangler-(?<version>\d+\.\d+\.\d+)\/review\.md)\)/gu;
const MAX_PERFORMANCE_README_BYTES = 2 * 1024 * 1024;
const MAX_PERFORMANCE_REVIEW_BYTES = 2 * 1024 * 1024;
const RELEASE_SOURCE_BINDINGS = new WeakMap();
const GIT_READ_TIMEOUT_MS = 5_000;
const MAX_GIT_COMMIT_BYTES = 2 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = DATA_WRANGLER_STUDY_REPORT_MAX_BYTES + 1;
export const HISTORICAL_PERFORMANCE_DISCLOSURE =
  "The linked comparison is retained historical evidence for an earlier Open Wrangler release. It does not describe current performance. New results will be summarized here only after a release-candidate study produces a complete reviewed report.";
const PERFORMANCE_OVERVIEW =
  "Open Wrangler fetches the grid blocks you can see instead of loading the whole dataset into the webview. File-backed Polars sessions use lazy scans, and live notebook LazyFrames keep their existing lazy plan. Filtering, sorting, and column selection stay in that plan until a bounded result or explicit export is requested. Pandas data stays in Pandas, and DuckDB relations stay in DuckDB.";

function numericReleaseMajor(version) {
  const match = typeof version === "string" ? NUMERIC_RELEASE_VERSION.exec(version) : null;
  return match === null ? undefined : BigInt(match.groups?.major ?? "");
}

function stableRParityProblems(featureParity, version, trackedEvidencePaths) {
  const major = numericReleaseMajor(version);
  return major !== undefined && major >= 2n
    ? inspectStableRParityMatrix(featureParity, R_STABLE_PARITY_SCOPE, trackedEvidencePaths)
    : [];
}

function markdownAtxHeading(line) {
  const html = /^ {0,3}<h2(?:[ \t]+[^>]*)?>(?<body>.*?)<\/h2>[ \t]*$/iu.exec(line);
  if (html !== null) {
    return { level: 2, span: 1, text: html.groups?.body ?? "" };
  }
  const match = /^ {0,3}(?<marks>#{1,6})(?:(?:[ \t]+(?<body>.*))|[ \t]*)$/u.exec(line);
  if (match === null) return undefined;
  const body = (match.groups?.body ?? "").replace(/[ \t]+#+[ \t]*$/u, "").trim();
  return { level: match.groups?.marks.length, span: 1, text: body };
}

function normalizedRenderedHeading(text) {
  return text
    .replace(/!?\[(?<label>[^\]]+)\]\([^\r\n)]*\)/gu, "$<label>")
    .replace(/[`*_~]/gu, "")
    .replace(/<[^>]*>/gu, "")
    .trim()
    .toLowerCase();
}

function markdownFence(line) {
  const match = /^ {0,3}(?<marks>`{3,}|~{3,})(?<info>.*)$/u.exec(line);
  if (match === null) return undefined;
  const marks = match.groups?.marks;
  const info = match.groups?.info ?? "";
  if (marks === undefined || (marks.startsWith("`") && info.includes("`"))) return undefined;
  return { character: marks[0], length: marks.length };
}

function closesMarkdownFence(line, fence) {
  const match = /^ {0,3}(?<marks>`{3,}|~{3,})[ \t]*$/u.exec(line);
  const marks = match?.groups?.marks;
  return marks !== undefined && marks[0] === fence.character && marks.length >= fence.length;
}

function visibleMarkdownLine(line) {
  let visible = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== "`") {
      visible += line[index];
      index += 1;
      continue;
    }
    let markerEnd = index;
    while (line[markerEnd] === "`") markerEnd += 1;
    const marker = line.slice(index, markerEnd);
    const closing = line.indexOf(marker, markerEnd);
    if (closing === -1) {
      visible += marker;
      index = markerEnd;
      continue;
    }
    visible += " ";
    index = closing + marker.length;
  }
  return visible.replace(/<!--[\s\S]*?-->/gu, " ").replace(/<[^>]*>/gu, " ");
}

function outsidePerformanceClaim(paragraph) {
  const text = normalizedPerformanceCopy(paragraph).toLowerCase();
  if (text === "") return false;
  const claimText = text.replace(/\btime zones?\b/gu, "");
  const linkedEvidence =
    /github\.com\/matt17br\/openwrangler\/blob\/main\/docs\/performance\/data-wrangler-[0-9]+\.[0-9]+\.[0-9]+\/review\.md/u.test(
      claimText
    );
  const currentEvidence =
    /\b(?:current|latest|new|present-day|today(?:'s)?)\b[^.\n]{0,80}\b(?:benchmark|comparison|performance|result|timing|evidence)\b/u.test(
      claimText
    );
  const metric =
    /\b(?:allocation|benchmark|cpu|duration|elapsed|fast|footprint|latency|memory|perform\w*|profiling|ram|resource|response|responsive|speed|startup|throughput|time|timing|wait|work(?:ing)?\s+set|workload)\w*\b/u.test(
      claimText
    );
  const comparative =
    /\b(?:ahead|behind|better|cut\w*|double|fewer|fraction|greater|half|higher|improv\w*|less|lower|more|reduc\w*|shorter|smaller|twice|twofold|worse)\b|\b\d+(?:\.\d+)?\s*(?:%|x)\b/u.test(
      claimText
    );
  const inherentlyComparative =
    /\b(?:accelerat\w*|beat\w*|faster|outperform\w*|quick(?:er|ly)|slower|sooner|speed(?:s|ing)?\s+up)\b/u.test(
      claimText
    );
  const measuredResult =
    /\b\d[\d,]*(?:\.\d+)?\s*(?:gib|gb|hours?|kib|kb|mb|mib|milliseconds?|minutes?|ms|rows?\s*(?:\/|per\s+)second|seconds?)\b/u.test(
      claimText
    );
  const namedProductClaim =
    /\b(?:data wrangler|open wrangler|the extension|the workbench)\b/u.test(claimText) &&
    /\b(?:efficient|fast|lightweight|low-latency|responsive|slow)\b/u.test(claimText);
  return (
    linkedEvidence ||
    currentEvidence ||
    (metric && comparative) ||
    inherentlyComparative ||
    measuredResult ||
    namedProductClaim
  );
}

function hasOutsidePerformanceClaim(rendered, sectionStart, sectionEnd) {
  const paragraphs = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length > 0) paragraphs.push(paragraph.join(" "));
    paragraph = [];
  };
  for (let index = 0; index < rendered.length; index += 1) {
    if (index >= sectionStart && index < sectionEnd) {
      flush();
      continue;
    }
    const entry = rendered[index];
    if (entry.code || entry.heading !== undefined || entry.line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(visibleMarkdownLine(entry.line));
  }
  flush();
  return paragraphs.some(outsidePerformanceClaim);
}

function performanceSection(readme) {
  if (typeof readme !== "string" || Buffer.byteLength(readme, "utf8") > MAX_PERFORMANCE_README_BYTES) {
    return undefined;
  }
  const lines = readme.replace(/\r\n?/gu, "\n").split("\n");
  const rendered = [];
  let fence;
  for (const line of lines) {
    if (fence !== undefined) {
      rendered.push({ code: true, heading: undefined, line });
      if (closesMarkdownFence(line, fence)) fence = undefined;
      continue;
    }
    const openingFence = markdownFence(line);
    if (openingFence !== undefined) {
      fence = openingFence;
      rendered.push({ code: true, heading: undefined, line });
      continue;
    }
    const code = /^(?: {4}|\t)/u.test(line);
    rendered.push({ code, heading: code ? undefined : markdownAtxHeading(line), line });
  }
  for (let index = 0; index + 1 < rendered.length; index += 1) {
    const entry = rendered[index];
    const underline = rendered[index + 1];
    if (
      !entry.code &&
      entry.heading === undefined &&
      entry.line.trim() !== "" &&
      !underline.code &&
      /^ {0,3}-+[ \t]*$/u.test(underline.line)
    ) {
      entry.heading = { level: 2, span: 2, text: entry.line.trim() };
    }
  }

  const headings = rendered
    .map((entry, index) => ({ ...entry.heading, index }))
    .filter((entry) => entry.level === 2 && normalizedRenderedHeading(entry.text ?? "") === "performance");
  if (headings.length !== 1) return undefined;
  const sectionStart = headings[0].index + headings[0].span;
  const followingHeading = rendered.findIndex(
    (entry, index) => index >= sectionStart && entry.heading !== undefined && entry.heading.level <= 2
  );
  const sectionEnd = followingHeading === -1 ? rendered.length : followingHeading;
  const entries = rendered.slice(sectionStart, sectionEnd);
  return {
    hasCodeContent: entries.some((entry) => entry.code && entry.line.trim() !== ""),
    hasOutsideClaim: hasOutsidePerformanceClaim(rendered, headings[0].index, sectionEnd),
    text: entries
      .filter((entry) => !entry.code)
      .map((entry) => entry.line)
      .join("\n")
  };
}

export function performanceReportLink(readme) {
  const section = performanceSection(readme);
  if (section === undefined) return undefined;
  const links = [...section.text.matchAll(PERFORMANCE_REPORT_LINK)];
  if (links.length !== 1) return undefined;

  const path = links[0]?.groups?.path;
  const version = links[0]?.groups?.version;
  return path === undefined || version === undefined ? undefined : { path, version };
}

function normalizedPerformanceCopy(value) {
  return value.replace(/\s+/gu, " ").trim();
}

function performanceReportUrl(path) {
  return `https://github.com/Matt17BR/openwrangler/blob/main/${path}`;
}

function historicalPerformanceCopy(report) {
  return `${PERFORMANCE_OVERVIEW} ${HISTORICAL_PERFORMANCE_DISCLOSURE} See the [historical benchmark report](${performanceReportUrl(report.path)}) for that release's test setup and reviewed results.`;
}

function currentPerformanceCopy(report, link) {
  const generatedDate = report.generatedAtUtc.slice(0, 10);
  const openWranglerVersion = report.provenance.openWrangler.version;
  const dataWranglerVersion = report.provenance.dataWrangler.version;
  const context =
    `Open Wrangler ${openWranglerVersion} and Data Wrangler ${dataWranglerVersion}; completed ${generatedDate}; ` +
    `Pandas and Polars with CSV and Parquet; ${report.completedSessions}/${report.plannedSessions} sessions and ` +
    `${report.completedSamples}/${report.plannedSamples} samples`;
  return `${PERFORMANCE_OVERVIEW} The [current comparison: ${context}](${performanceReportUrl(link.path)}) recorded no material median regressions under its release gate.`;
}

function currentPerformanceLinkOnlyCopy(link) {
  return `[dated report](${performanceReportUrl(link.path)})`;
}

export function inspectPerformanceSummary(readme, { currentReport } = {}) {
  const section = performanceSection(readme);
  if (section === undefined) {
    return ["README must contain exactly one Performance section with one versioned Data Wrangler review."];
  }
  if (section.hasOutsideClaim) {
    return ["README performance comparisons and current-result claims must appear only in its Performance section."];
  }
  const report = performanceReportLink(readme);
  if (report === undefined) {
    return ["README Performance must link exactly one versioned Data Wrangler review."];
  }

  const observed = normalizedPerformanceCopy(section.text);
  if (!section.hasCodeContent && observed === normalizedPerformanceCopy(historicalPerformanceCopy(report))) return [];
  if (!section.hasCodeContent && observed === normalizedPerformanceCopy(currentPerformanceLinkOnlyCopy(report)))
    return [];
  if (currentReport !== undefined) {
    try {
      assertReleaseCompleteStudyReport(currentReport);
      if (
        currentReport.provenance.openWrangler.version === report.version &&
        !section.hasCodeContent &&
        observed === normalizedPerformanceCopy(currentPerformanceCopy(currentReport, report))
      ) {
        return [];
      }
    } catch {
      // A malformed or incomplete report cannot authorize current comparative copy.
    }
  }
  return [
    currentReport === undefined
      ? "README Performance must use the exact linked historical-evidence summary or neutral link-only summary while no current completed report is proven."
      : "README Performance must use the exact linked historical summary, neutral current-report link, or report-derived current summary."
  ];
}

export function classifyCurrentCompletedPerformanceReport({
  candidateSha256,
  performanceReportSourceCommit,
  report,
  reportVersion,
  sourceCommit,
  sourceVersion
}) {
  try {
    assertReleaseCompleteStudyReport(report);
  } catch (error) {
    return {
      completenessError: String(error?.message ?? error),
      current: false,
      provenanceVersion: report?.provenance?.openWrangler?.version
    };
  }

  const provenanceVersion = report.provenance.openWrangler.version;
  const candidateMatches =
    typeof candidateSha256 === "string" &&
    SHA256.test(candidateSha256) &&
    report.provenance.openWrangler.sha256 === candidateSha256;
  const sourceMatches =
    typeof sourceCommit === "string" &&
    sourceCommit === sourceCommit.toLowerCase() &&
    FULL_COMMIT_ID.test(sourceCommit) &&
    performanceReportSourceCommit === sourceCommit;
  return {
    candidateMatches,
    current:
      reportVersion === sourceVersion && provenanceVersion === reportVersion && candidateMatches && sourceMatches,
    provenanceVersion,
    sourceMatches
  };
}

function inspectLabeledPerformanceSummary(readme, label, currentReport) {
  return inspectPerformanceSummary(readme, { currentReport }).map((problem) => problem.replace(/^README\b/u, label));
}

function inspectStablePerformanceEvidence(
  readme,
  label,
  version,
  trackedEvidencePaths,
  performanceReportFiles,
  candidateSha256,
  sourceCommit,
  performanceReportSourceCommit
) {
  const major = /^(?<major>0|[1-9]\d*)\./u.exec(version ?? "")?.groups?.major;
  if (major === undefined || BigInt(major) < 2n) return [];

  const report = performanceReportLink(readme);
  if (report === undefined) {
    return [
      `${label} Performance section must link exactly one versioned Data Wrangler review.`,
      ...inspectLabeledPerformanceSummary(readme, label, undefined)
    ];
  }

  const problems = [];
  const sourceMatch = NUMERIC_RELEASE_VERSION.exec(version);
  const reportMatch = NUMERIC_RELEASE_VERSION.exec(report.version);
  const sameReleaseLine =
    sourceMatch !== null &&
    reportMatch !== null &&
    sourceMatch.groups?.major === reportMatch.groups?.major &&
    sourceMatch.groups?.minor === reportMatch.groups?.minor &&
    BigInt(reportMatch.groups?.patch ?? "") <= BigInt(sourceMatch.groups?.patch ?? "");
  if (!sameReleaseLine) {
    problems.push(
      `${label} Performance report version ${report.version} does not cover source release line ${sourceMatch?.groups?.major}.${sourceMatch?.groups?.minor}.x at ${version}.`
    );
  }
  if (!trackedEvidencePaths.has(report.path)) {
    problems.push(`${label} Performance report ${report.path} must be tracked.`);
  }
  const reportJsonPath = report.path.replace(/review\.md$/u, "report.json");
  if (!trackedEvidencePaths.has(reportJsonPath)) {
    problems.push(`${label} Performance data ${reportJsonPath} must be tracked.`);
  }
  const reportSource = performanceReportFiles.get(reportJsonPath);
  if (reportSource === undefined) {
    problems.push(`${label} Performance data ${reportJsonPath} must be read from the release commit.`);
    return [...problems, ...inspectLabeledPerformanceSummary(readme, label, undefined)];
  }
  const reportData = parseJsonObject(reportSource, `${label} Performance data ${reportJsonPath}`, problems);
  if (reportData === undefined) {
    return [...problems, ...inspectLabeledPerformanceSummary(readme, label, undefined)];
  }
  const immutableSourceBinding = RELEASE_SOURCE_BINDINGS.get(performanceReportFiles);
  const snapshotSourceCommit =
    immutableSourceBinding?.files.get(reportJsonPath) === reportSource ? immutableSourceBinding.commit : undefined;
  const classification = classifyCurrentCompletedPerformanceReport({
    candidateSha256,
    performanceReportSourceCommit: performanceReportSourceCommit ?? snapshotSourceCommit,
    report: reportData,
    reportVersion: report.version,
    sourceCommit: sourceCommit ?? snapshotSourceCommit,
    sourceVersion: version
  });
  if (classification.completenessError !== undefined) {
    problems.push(
      `${label} Performance data ${reportJsonPath} is incomplete or invalid: ${classification.completenessError}`
    );
    return [...problems, ...inspectLabeledPerformanceSummary(readme, label, undefined)];
  }
  const reportedVersion = classification.provenanceVersion;
  if (reportedVersion !== report.version) {
    problems.push(
      `${label} Performance data ${reportJsonPath} describes Open Wrangler ${String(reportedVersion)}, not ${report.version}.`
    );
  }
  if (report.version === version && classification.candidateMatches !== true) {
    problems.push(`${label} Performance data ${reportJsonPath} does not match the release candidate VSIX.`);
  }
  if (report.version === version && classification.sourceMatches !== true) {
    problems.push(`${label} Performance data ${reportJsonPath} is not bound to the exact release source commit.`);
  }
  const currentReport =
    trackedEvidencePaths.has(report.path) && trackedEvidencePaths.has(reportJsonPath) && classification.current
      ? reportData
      : undefined;
  problems.push(...inspectLabeledPerformanceSummary(readme, label, currentReport));
  return problems;
}

function parseJsonObject(contents, label, problems) {
  let value;
  try {
    value = parseStrictJson(contents);
  } catch (error) {
    problems.push(
      error instanceof DuplicateJsonKeyError
        ? `${label} must not contain duplicate object keys.`
        : `${label} must contain valid bounded JSON.`
    );
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    problems.push(`${label} must contain a JSON object.`);
    return undefined;
  }
  return value;
}

function parsePythonRuntimeVersion(contents, label, problems) {
  const matches = [...contents.matchAll(PYTHON_VERSION)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    problems.push(`${label} must contain exactly one __version__ = "..." assignment.`);
    return undefined;
  }
  return matches[0][1];
}

function parseVsixIdentity(contents) {
  const path = [];
  const identities = [];
  let rootIsCanonical = false;
  let metadataCount = 0;
  let canonicalMetadataCount = 0;
  let parseFailed = false;
  const parser = new SaxesParser({ xmlns: true });

  parser.on("doctype", () => {
    parseFailed = true;
  });
  parser.on("opentag", (tag) => {
    path.push({ name: tag.name, uri: tag.uri });
    const canonicalPrefix = (names) =>
      path.length >= names.length &&
      path
        .slice(0, names.length)
        .every((element, index) => element.name === names[index] && element.uri === VSIX_MANIFEST_NAMESPACE);

    if (path.length === 1) {
      rootIsCanonical = canonicalPrefix(["PackageManifest"]);
      return;
    }
    if (path.length === 2 && path[0]?.name === "PackageManifest" && tag.name === "Metadata") {
      metadataCount += 1;
      canonicalMetadataCount += Number(canonicalPrefix(["PackageManifest", "Metadata"]));
      return;
    }
    if (path.length !== 3 || !canonicalPrefix(["PackageManifest", "Metadata", "Identity"])) {
      return;
    }

    const plainAttributes = Object.values(tag.attributes).filter(
      (attribute) => typeof attribute === "object" && attribute.prefix === "" && attribute.uri === ""
    );
    const attribute = (name) =>
      plainAttributes.find((candidate) => candidate.local === name && candidate.name === name)?.value;
    identities.push({
      id: attribute("Id"),
      version: attribute("Version"),
      publisher: attribute("Publisher")
    });
  });
  parser.on("closetag", () => {
    path.pop();
  });

  try {
    parser.write(contents).close();
  } catch {
    parseFailed = true;
  }

  if (
    parseFailed ||
    !rootIsCanonical ||
    metadataCount !== 1 ||
    canonicalMetadataCount !== 1 ||
    identities.length !== 1
  ) {
    return undefined;
  }
  return identities[0];
}

function inspectReleaseReadiness(
  {
    releaseTag,
    sourcePackageJson,
    pythonVersionFile,
    featureParity,
    changelog,
    readme,
    packagedPackageJson,
    packagedPythonVersionFile,
    packagedReadme,
    vsixManifest,
    trackedEvidencePaths = new Set(),
    performanceReportFiles = new Map(),
    candidateSha256,
    sourceCommit,
    performanceReportSourceCommit
  },
  {
    allowedIncompleteRows = new Map(),
    inspectReadme = inspectStableReadme,
    requiredIncompleteRows = new Map(),
    requiredVersion
  } = {}
) {
  const problems = [];
  const sourceManifest = parseJsonObject(sourcePackageJson, "Source package.json", problems);
  const packagedManifest = parseJsonObject(packagedPackageJson, "Packaged package.json", problems);
  const sourceVersion = typeof sourceManifest?.version === "string" ? sourceManifest.version : undefined;
  const pythonVersion = parsePythonRuntimeVersion(
    pythonVersionFile,
    "python/openwrangler_runtime/version.py",
    problems
  );
  const packagedPythonVersion = parsePythonRuntimeVersion(
    packagedPythonVersionFile,
    "Packaged Python runtime version.py",
    problems
  );

  const sourceVersionClassification = classifyNumericReleaseVersion(sourceVersion);
  if (sourceVersionClassification === undefined) {
    problems.push("Source package.json version must use stable major.minor.patch syntax.");
  } else if (sourceVersionClassification.channel !== "stable") {
    problems.push(
      `Source package.json version ${sourceVersion} is reserved for preview releases and cannot pass stable readiness.`
    );
  }
  if (requiredVersion !== undefined && sourceVersion !== requiredVersion) {
    problems.push(`Performance-evidence authoring is limited to version ${requiredVersion}.`);
  }
  for (const [field, expected] of Object.entries(STABLE_PACKAGE_IDENTITY)) {
    if (sourceManifest?.[field] !== expected) {
      problems.push(`Source package.json ${field} must be ${JSON.stringify(expected)} for a stable release.`);
    }
  }
  if (sourceManifest?.preview !== false) {
    problems.push("Source package.json preview must be false for a stable release.");
  }
  if (sourceVersion !== undefined && releaseTag !== `v${sourceVersion}`) {
    problems.push(`Release tag ${String(releaseTag)} does not match source version v${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && pythonVersion !== undefined && sourceVersion !== pythonVersion) {
    problems.push(`Python runtime version ${pythonVersion} does not match source package version ${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && packagedPythonVersion !== undefined && sourceVersion !== packagedPythonVersion) {
    problems.push(
      `Packaged Python runtime version ${packagedPythonVersion} does not match source package version ${sourceVersion}.`
    );
  }

  if (sourceVersion !== undefined) {
    problems.push(...inspectChangelog(changelog, sourceVersion));
  }
  problems.push(
    ...inspectPrimaryParityMatrix(
      featureParity,
      PRIMARY_PARITY_SCOPE,
      trackedEvidencePaths,
      allowedIncompleteRows,
      requiredIncompleteRows
    )
  );
  problems.push(...stableRParityProblems(featureParity, sourceVersion, trackedEvidencePaths));
  problems.push(...inspectReadme(readme, "README.md"));
  problems.push(...inspectReadme(packagedReadme, "Packaged README"));
  if (inspectReadme === inspectStableReadme && sourceVersion !== undefined) {
    problems.push(
      ...inspectStablePerformanceEvidence(
        readme,
        "README.md",
        sourceVersion,
        trackedEvidencePaths,
        performanceReportFiles,
        candidateSha256,
        sourceCommit,
        performanceReportSourceCommit
      )
    );
    problems.push(
      ...inspectStablePerformanceEvidence(
        packagedReadme,
        "Packaged README",
        sourceVersion,
        trackedEvidencePaths,
        performanceReportFiles,
        candidateSha256,
        sourceCommit,
        performanceReportSourceCommit
      )
    );
  }

  if (packagedManifest?.preview !== false) {
    problems.push("Packaged package.json preview must be false for a stable release.");
  }
  for (const field of ["name", "displayName", "publisher", "version"]) {
    if (sourceManifest?.[field] !== packagedManifest?.[field]) {
      problems.push(`Packaged package.json ${field} does not match source package.json.`);
    }
  }
  if (
    sourceManifest !== undefined &&
    packagedManifest !== undefined &&
    !isDeepStrictEqual(sourceManifest, packagedManifest)
  ) {
    problems.push(
      "Packaged package.json must exactly match source package.json; no packaging transformations are permitted."
    );
  }

  problems.push(...inspectVsixPreReleaseMetadata(packagedPackageJson, vsixManifest));
  if (packagedManifest !== undefined) {
    problems.push(
      ...inspectVsixPreReleaseMetadata(JSON.stringify({ ...packagedManifest, preview: false }), vsixManifest)
    );
  }
  const identity = parseVsixIdentity(vsixManifest);
  if (identity === undefined) {
    problems.push("VSIX manifest must contain one canonical Metadata > Identity element.");
  } else {
    if (identity.id !== sourceManifest?.name) {
      problems.push("VSIX identity ID does not match source package.json name.");
    }
    if (identity.publisher !== sourceManifest?.publisher) {
      problems.push("VSIX identity publisher does not match source package.json publisher.");
    }
    if (identity.version !== sourceVersion) {
      problems.push("VSIX identity version does not match source package.json version.");
    }
  }

  return [...new Set(problems)];
}

export function inspectStableReleaseReadiness(options) {
  return inspectReleaseReadiness(options);
}

export function inspectPreviewReleaseReadiness({
  releaseTag,
  sourcePackageJson,
  pythonVersionFile,
  packagedPackageJson,
  packagedPythonVersionFile,
  vsixManifest
}) {
  const problems = [];
  const sourceManifest = parseJsonObject(sourcePackageJson, "Source package.json", problems);
  const packagedManifest = parseJsonObject(packagedPackageJson, "Packaged package.json", problems);
  const sourceVersion = typeof sourceManifest?.version === "string" ? sourceManifest.version : undefined;
  const pythonVersion = parsePythonRuntimeVersion(
    pythonVersionFile,
    "python/openwrangler_runtime/version.py",
    problems
  );
  const packagedPythonVersion = parsePythonRuntimeVersion(
    packagedPythonVersionFile,
    "Packaged Python runtime version.py",
    problems
  );

  const sourceVersionClassification = classifyNumericReleaseVersion(sourceVersion);
  if (sourceVersionClassification === undefined) {
    problems.push("Source package.json version must use major.minor.patch syntax.");
  } else if (sourceVersionClassification.channel !== "preview") {
    problems.push(`Source package.json version ${sourceVersion} is not reserved for preview releases.`);
  }
  for (const [field, expected] of Object.entries(STABLE_PACKAGE_IDENTITY)) {
    if (sourceManifest?.[field] !== expected) {
      problems.push(`Source package.json ${field} must be ${JSON.stringify(expected)} for a preview release.`);
    }
  }
  if (sourceManifest?.preview !== true) {
    problems.push("Source package.json preview must be true for a preview release.");
  }
  if (sourceVersion !== undefined && releaseTag !== `v${sourceVersion}`) {
    problems.push(`Release tag ${String(releaseTag)} does not match source version v${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && pythonVersion !== undefined && sourceVersion !== pythonVersion) {
    problems.push(`Python runtime version ${pythonVersion} does not match source package version ${sourceVersion}.`);
  }
  if (sourceVersion !== undefined && packagedPythonVersion !== undefined && sourceVersion !== packagedPythonVersion) {
    problems.push(
      `Packaged Python runtime version ${packagedPythonVersion} does not match source package version ${sourceVersion}.`
    );
  }

  if (packagedManifest?.preview !== true) {
    problems.push("Packaged package.json preview must be true for a preview release.");
  }
  if (
    sourceManifest !== undefined &&
    packagedManifest !== undefined &&
    !isDeepStrictEqual(sourceManifest, packagedManifest)
  ) {
    problems.push(
      "Packaged package.json must exactly match source package.json; no packaging transformations are permitted."
    );
  }
  problems.push(...inspectVsixPreReleaseMetadata(packagedPackageJson, vsixManifest));

  const identity = parseVsixIdentity(vsixManifest);
  if (identity === undefined) {
    problems.push("VSIX manifest must contain one canonical Metadata > Identity element.");
  } else {
    if (identity.id !== sourceManifest?.name) {
      problems.push("VSIX identity ID does not match source package.json name.");
    }
    if (identity.publisher !== sourceManifest?.publisher) {
      problems.push("VSIX identity publisher does not match source package.json publisher.");
    }
    if (identity.version !== sourceVersion) {
      problems.push("VSIX identity version does not match source package.json version.");
    }
  }

  return [...new Set(problems)];
}

export function inspectStableSourceReadiness({ featureParity, readme, trackedEvidencePaths = new Set(), version }) {
  const versionClassification = classifyNumericReleaseVersion(version);
  const major = numericReleaseMajor(version);
  return [
    ...(major === undefined ? ["Stable source version must use major.minor.patch syntax."] : []),
    ...(versionClassification !== undefined && versionClassification.channel !== "stable"
      ? [`Stable source version ${version} is reserved for preview releases.`]
      : []),
    ...inspectPrimaryParityMatrix(featureParity, PRIMARY_PARITY_SCOPE, trackedEvidencePaths),
    ...(major !== undefined && major >= 2n
      ? inspectStableRParityMatrix(featureParity, R_STABLE_PARITY_SCOPE, trackedEvidencePaths)
      : []),
    ...inspectStableReadme(readme, "README.md")
  ];
}

export function inspectPreviewRParitySource({ featureParity }) {
  return inspectPreviewRParityMatrix(featureParity, R_PREVIEW_PARITY_SCOPE);
}

export function inspectReleaseDocumentationSource({
  featureParity,
  preview,
  readme,
  trackedEvidencePaths = new Set(),
  version
}) {
  const classification = classifyNumericReleaseVersion(version);
  const problems = [
    ...(classification === undefined ? ["Source version must use major.minor.patch syntax."] : []),
    ...(typeof preview === "boolean" ? [] : ['Source package.json "preview" must be an explicit boolean.']),
    ...(classification !== undefined &&
    typeof preview === "boolean" &&
    preview !== (classification.channel === "preview")
      ? [
          classification.channel === "preview"
            ? `Preview-channel version ${version} requires source package.json "preview" to be true.`
            : `Stable-channel version ${version} requires source package.json "preview" to be false.`
        ]
      : [])
  ];
  if (problems.length > 0 || classification === undefined) {
    return problems;
  }
  return classification.channel === "preview"
    ? [...inspectPreviewReadme(readme), ...inspectPreviewRParitySource({ featureParity })]
    : inspectStableSourceReadiness({ featureParity, readme, trackedEvidencePaths, version });
}

export function inspectPerformanceEvidenceCandidateReadiness(options) {
  return inspectReleaseReadiness(options, {
    allowedIncompleteRows: PERFORMANCE_EVIDENCE_ALLOWED_INCOMPLETE_ROWS,
    inspectReadme: inspectPerformanceEvidenceReadme,
    requiredIncompleteRows: PERFORMANCE_EVIDENCE_ALLOWED_INCOMPLETE_ROWS,
    requiredVersion: PERFORMANCE_EVIDENCE_VERSION
  });
}

export function inspectPerformanceEvidenceSourceReadiness({
  featureParity,
  readme,
  trackedEvidencePaths = new Set(),
  version
}) {
  return [
    ...(version === PERFORMANCE_EVIDENCE_VERSION
      ? []
      : [`Performance-evidence authoring is limited to version ${PERFORMANCE_EVIDENCE_VERSION}.`]),
    ...inspectPrimaryParityMatrix(
      featureParity,
      PRIMARY_PARITY_SCOPE,
      trackedEvidencePaths,
      PERFORMANCE_EVIDENCE_ALLOWED_INCOMPLETE_ROWS,
      PERFORMANCE_EVIDENCE_ALLOWED_INCOMPLETE_ROWS
    ),
    ...inspectPerformanceEvidenceReadme(readme, "README.md")
  ];
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchangedFileSnapshot(before, after) {
  return (
    sameFileIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function resolveGitExecutable() {
  const names = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const name of names) {
      try {
        const executable = realpathSync.native(resolve(directory, name));
        if (!lstatSync(executable).isFile()) continue;
        accessSync(executable, fsConstants.X_OK);
        return executable;
      } catch {
        // Continue until one canonical executable is found on the initial trusted PATH.
      }
    }
  }
  throw new Error("Git must resolve to one executable regular file before release evidence is inspected.");
}

const GIT_EXECUTABLE = resolveGitExecutable();
const GIT_READ_ENVIRONMENT = Object.freeze({
  GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_NO_LAZY_FETCH: "1",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LANG: "C",
  LC_ALL: "C",
  PAGER: "cat",
  PATH: dirname(GIT_EXECUTABLE),
  ...(process.platform === "win32"
    ? Object.fromEntries(
        ["SYSTEMROOT", "WINDIR"]
          .filter((name) => typeof process.env[name] === "string")
          .map((name) => [name, process.env[name]])
      )
    : {})
});

function runGit(root, args, options = {}) {
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  if (
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== "string" || containsAsciiControl(argument)) ||
    !Number.isSafeInteger(maxBuffer) ||
    maxBuffer <= 0 ||
    maxBuffer > MAX_GIT_OUTPUT_BYTES ||
    (options.encoding !== undefined && options.encoding !== "utf8")
  ) {
    throw new Error("A bounded Git read requires safe arguments, encoding, and output limits.");
  }
  return execFileSync(
    GIT_EXECUTABLE,
    [
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-c",
      "core.useReplaceRefs=false",
      ...args
    ],
    {
      cwd: root,
      encoding: options.encoding,
      env: GIT_READ_ENVIRONMENT,
      killSignal: "SIGKILL",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_READ_TIMEOUT_MS,
      windowsHide: true
    }
  );
}

function decodeUtf8(contents, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(contents);
  } catch (error) {
    throw new Error(`${label} must be valid UTF-8 at the release commit.`, { cause: error });
  }
}

function containsAsciiControl(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function gitObjectHash(type, contents, object) {
  const algorithm = object.length === 40 ? "sha1" : object.length === 64 ? "sha256" : undefined;
  if (algorithm === undefined) {
    throw new Error("Git returned an unsupported object ID length.");
  }
  return createHash(algorithm)
    .update(Buffer.from(`${type} ${contents.length}\0`, "utf8"))
    .update(contents)
    .digest("hex");
}

function readExactGitObject(root, object, type, maxBytes, label) {
  const objectType = runGit(root, ["cat-file", "-t", object], {
    encoding: "utf8",
    maxBuffer: 1024
  }).trim();
  if (objectType !== type) {
    throw new Error(`${label} must resolve to one ${type} Git object.`);
  }
  const sizeText = runGit(root, ["cat-file", "-s", object], {
    encoding: "utf8",
    maxBuffer: 1024
  }).trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(sizeText)) {
    throw new Error(`${label} has an invalid Git object size.`);
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) {
    throw new Error(`${label} exceeds its ${maxBytes}-byte commit snapshot limit.`);
  }
  const contents = runGit(root, ["cat-file", type, object], { maxBuffer: maxBytes + 1 });
  if (!Buffer.isBuffer(contents) || contents.length !== size) {
    throw new Error(`${label} did not match its Git object size.`);
  }
  if (gitObjectHash(type, contents, object) !== object) {
    throw new Error(`${label} bytes do not hash back to their bound Git object ID.`);
  }
  return contents;
}

function resolveExactGitCommit(root, commit) {
  const resolvedCommit = runGit(root, ["rev-parse", "--verify", "--end-of-options", `${commit}^{commit}`], {
    encoding: "utf8",
    maxBuffer: 1024
  }).trim();
  if (resolvedCommit !== commit.toLowerCase()) {
    throw new Error("A bounded Git blob read must resolve the exact requested commit.");
  }
  const commitBytes = readExactGitObject(root, resolvedCommit, "commit", MAX_GIT_COMMIT_BYTES, "Release commit");
  const firstLineEnd = commitBytes.indexOf(0x0a);
  const firstLine = firstLineEnd === -1 ? "" : commitBytes.subarray(0, firstLineEnd).toString("ascii");
  const tree = /^tree (?<object>[0-9a-f]{40}|[0-9a-f]{64})$/u.exec(firstLine)?.groups?.object;
  if (tree === undefined || tree.length !== resolvedCommit.length) {
    throw new Error("Release commit must bind one canonical root tree object ID.");
  }
  readExactGitObject(root, tree, "tree", DATA_WRANGLER_STUDY_REPORT_MAX_BYTES, "Release root tree");
  return Object.freeze({ commit: resolvedCommit, tree });
}

function readBoundedGitBlobFromTree({ maxBytes, path, required, root, tree }) {
  const entry = runGit(root, ["ls-tree", "-z", tree, "--", path], { maxBuffer: 4096 });
  if (!Buffer.isBuffer(entry) || entry.length === 0) {
    if (!required) return undefined;
    throw new Error(`Release commit is missing required tracked source ${path}.`);
  }
  const match = /^(?<mode>[0-9]{6}) (?<type>[a-z]+) (?<object>[0-9a-f]{40,64})\t(?<path>[^\0]+)\0$/u.exec(
    entry.toString("utf8")
  );
  const groups = match?.groups;
  if (
    groups === undefined ||
    groups.path !== path ||
    groups.type !== "blob" ||
    !["100644", "100755"].includes(groups.mode) ||
    groups.object.length !== tree.length
  ) {
    throw new Error(`Release source ${path} must be one regular tracked Git blob.`);
  }
  const contents = readExactGitObject(root, groups.object, "blob", maxBytes, `Release source ${path}`);
  return Object.freeze({ blob: groups.object, contents: decodeUtf8(contents, path) });
}

export function readBoundedGitBlobSnapshot({ commit, maxBytes, path, required = true, root }) {
  if (typeof commit !== "string" || !FULL_COMMIT_ID.test(commit)) {
    throw new Error("A bounded Git blob read requires one full hexadecimal commit ID.");
  }
  if (
    typeof path !== "string" ||
    Buffer.byteLength(path, "utf8") > 1024 ||
    containsAsciiControl(path) ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("A bounded Git blob read requires one normalized repository-relative path.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > DATA_WRANGLER_STUDY_REPORT_MAX_BYTES) {
    throw new Error("A bounded Git blob read requires a safe positive byte limit.");
  }

  const absoluteRoot = resolve(root);
  const binding = resolveExactGitCommit(absoluteRoot, commit);
  return readBoundedGitBlobFromTree({ maxBytes, path, required, root: absoluteRoot, tree: binding.tree })?.contents;
}

export function readReleaseSourceSnapshot({ expectedCommit, root }) {
  if (typeof expectedCommit !== "string" || !FULL_COMMIT_ID.test(expectedCommit)) {
    throw new Error("EXPECTED_SHA must be one full hexadecimal Git commit ID.");
  }
  const absoluteRoot = resolve(root);
  const binding = resolveExactGitCommit(absoluteRoot, expectedCommit);
  const head = runGit(absoluteRoot, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], {
    encoding: "utf8",
    maxBuffer: 1024
  }).trim();
  if (head !== binding.commit) {
    throw new Error("Release readiness must inspect the exact checked-out event commit.");
  }

  const trackedPaths = new Set(
    runGit(absoluteRoot, ["ls-tree", "-r", "--name-only", "-z", binding.tree, "--"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
  );
  const files = new Map();
  const blobOids = new Map();
  const sourceBinding = { commit: binding.commit, files: new Map() };
  RELEASE_SOURCE_BINDINGS.set(files, sourceBinding);
  const readCommitFile = (path, maxBytes, required) => {
    const snapshot = readBoundedGitBlobFromTree({
      maxBytes,
      path,
      required,
      root: absoluteRoot,
      tree: binding.tree
    });
    if (snapshot !== undefined) {
      blobOids.set(path, snapshot.blob);
      files.set(path, snapshot.contents);
      sourceBinding.files.set(path, snapshot.contents);
    }
  };
  for (const [path, maxBytes] of RELEASE_SOURCE_FILES) {
    readCommitFile(path, maxBytes, true);
  }
  let sourceVersion;
  try {
    sourceVersion = parseStrictJson(files.get("package.json"))?.version;
  } catch {
    // Stable readiness reports malformed package metadata after the immutable read.
  }
  const sourceMajor = /^(?<major>0|[1-9]\d*)\./u.exec(sourceVersion ?? "")?.groups?.major;
  if (sourceMajor !== undefined && BigInt(sourceMajor) >= 2n) {
    const linkedReport = performanceReportLink(files.get("README.md"));
    if (linkedReport !== undefined) {
      readCommitFile(linkedReport.path, MAX_PERFORMANCE_REVIEW_BYTES, false);
      readCommitFile(
        linkedReport.path.replace(/review\.md$/u, "report.json"),
        DATA_WRANGLER_STUDY_REPORT_MAX_BYTES,
        false
      );
    }
  }
  return Object.freeze({
    blobOids,
    commit: binding.commit,
    files,
    tree: binding.tree,
    trackedPaths
  });
}

export function readOwnedVsixSnapshot(vsixPath) {
  const snapshot = readBoundedVsixFileSnapshot(vsixPath, { requireOwner: true });
  return Object.freeze({
    bytes: snapshot.bytes,
    sha256: sha256(snapshot.bytes),
    sourceIdentity: snapshot.identity
  });
}

export async function readStableVsixPayload(bytes) {
  return await inspectVsixArchive(bytes);
}

function readParentIdentity(path) {
  const absolutePath = resolve(path);
  const parentPath = realpathSync.native(dirname(absolutePath));
  const parent = lstatSync(parentPath, { bigint: true });
  if (!parent.isDirectory()) {
    throw new Error(`Release output parent must be a directory: ${basename(path)}.`);
  }
  return Object.freeze({
    parentDev: parent.dev,
    parentIno: parent.ino,
    parentPath,
    outputName: basename(absolutePath),
    outputPath: join(parentPath, basename(absolutePath))
  });
}

function sameParent(path, receipt) {
  try {
    const absolutePath = resolve(path);
    const current = lstatSync(receipt.parentPath, { bigint: true });
    return (
      basename(absolutePath) === receipt.outputName &&
      realpathSync.native(dirname(absolutePath)) === receipt.parentPath &&
      current.isDirectory() &&
      current.dev === receipt.parentDev &&
      current.ino === receipt.parentIno &&
      realpathSync.native(receipt.parentPath) === receipt.parentPath
    );
  } catch {
    return false;
  }
}

function sameReceipt(path, receipt) {
  try {
    const current = lstatSync(receipt.outputPath, { bigint: true });
    return (
      sameParent(path, receipt) &&
      current.isFile() &&
      current.nlink === 1n &&
      sameFileIdentity(current, receipt) &&
      (receipt.size === undefined || current.size === receipt.size) &&
      (receipt.mode === undefined || (current.mode & 0o777n) === receipt.mode) &&
      (receipt.mtimeNs === undefined || current.mtimeNs === receipt.mtimeNs) &&
      (receipt.ctimeNs === undefined || current.ctimeNs === receipt.ctimeNs)
    );
  } catch {
    return false;
  }
}

function removeOwnedOutput(path, receipt) {
  if (!sameReceipt(path, receipt)) {
    throw new Error(`Refusing to clean an unverified release output: ${basename(path)}.`);
  }
  unlinkSync(receipt.outputPath);
}

function writeExclusiveOwnedOutput(path, contents) {
  const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const parentReceipt = readParentIdentity(path);
  const outputPath = parentReceipt.outputPath;
  let descriptor;
  let receipt;
  let failure;
  try {
    descriptor = openSync(
      outputPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
      0o600
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid()))
    ) {
      throw new Error(`Release output ownership could not be established: ${basename(path)}.`);
    }
    receipt = { ...parentReceipt, dev: opened.dev, ino: opened.ino };

    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) {
        throw new Error(`Release output write did not make progress: ${basename(path)}.`);
      }
      offset += written;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(opened, completed) || completed.size !== BigInt(bytes.length)) {
      throw new Error(`Release output changed while it was published: ${basename(path)}.`);
    }
    receipt = {
      ...receipt,
      ctimeNs: completed.ctimeNs,
      mtimeNs: completed.mtimeNs,
      sha256: sha256(bytes),
      mode: process.platform === "win32" ? undefined : 0o444n,
      size: completed.size
    };
  } catch (error) {
    failure = error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  if (failure !== undefined) {
    if (receipt !== undefined && sameReceipt(path, receipt)) {
      removeOwnedOutput(path, receipt);
    }
    throw failure;
  }
  if (receipt === undefined || !sameReceipt(path, receipt)) {
    throw new Error(`Release output identity was lost after close: ${basename(path)}.`);
  }
  return Object.freeze(receipt);
}

function readVerifiedOutput(path, receipt) {
  if (!sameReceipt(path, receipt)) {
    throw new Error(`Release output identity or parent changed: ${basename(path)}.`);
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let descriptor;
  try {
    descriptor = openSync(receipt.outputPath, fsConstants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !sameFileIdentity(before, receipt) || before.size !== receipt.size) {
      throw new Error(`Release output changed before final content verification: ${basename(path)}.`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      bytes.length !== Number(before.size) ||
      !unchangedFileSnapshot(before, after) ||
      sha256(bytes) !== receipt.sha256 ||
      !sameReceipt(path, receipt)
    ) {
      throw new Error(`Release output content changed during final verification: ${basename(path)}.`);
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function revalidateStableReleaseArtifacts({
  afterVsixRead,
  checksumOutput,
  checksumReceipt,
  snapshot,
  vsixOutput,
  vsixReceipt
}) {
  if (
    !Buffer.isBuffer(snapshot?.bytes) ||
    typeof snapshot?.sha256 !== "string" ||
    sha256(snapshot.bytes) !== snapshot.sha256
  ) {
    throw new Error("Stable release snapshot digest no longer matches its inspected bytes.");
  }
  const vsixBytes = readVerifiedOutput(resolve(vsixOutput), vsixReceipt);
  if (!vsixBytes.equals(snapshot.bytes)) {
    throw new Error("Published stable VSIX does not match the inspected immutable snapshot.");
  }
  afterVsixRead?.();
  const checksumBytes = readVerifiedOutput(resolve(checksumOutput), checksumReceipt);
  const expectedChecksum = Buffer.from(`${snapshot.sha256}  ${basename(resolve(vsixOutput))}\n`, "utf8");
  if (!checksumBytes.equals(expectedChecksum)) {
    throw new Error("Published stable checksum does not match the inspected immutable snapshot.");
  }
  if (!sameReceipt(resolve(vsixOutput), vsixReceipt) || !sameReceipt(resolve(checksumOutput), checksumReceipt)) {
    throw new Error("Published stable outputs did not retain one joint final identity.");
  }
}

export function writeStableReleaseArtifacts({ snapshot, vsixOutput, checksumOutput }) {
  if (
    !Buffer.isBuffer(snapshot?.bytes) ||
    typeof snapshot?.sha256 !== "string" ||
    sha256(snapshot.bytes) !== snapshot.sha256
  ) {
    throw new Error("Stable release snapshot digest no longer matches its inspected bytes.");
  }
  const resolvedVsixOutput = resolve(vsixOutput);
  const resolvedChecksumOutput = resolve(checksumOutput);
  if (resolvedVsixOutput === resolvedChecksumOutput) {
    throw new Error("Stable VSIX and checksum outputs must be different paths.");
  }

  let vsixReceipt;
  let checksumReceipt;
  try {
    vsixReceipt = writeExclusiveOwnedOutput(resolvedVsixOutput, snapshot.bytes);
    checksumReceipt = writeExclusiveOwnedOutput(
      resolvedChecksumOutput,
      `${snapshot.sha256}  ${basename(resolvedVsixOutput)}\n`
    );
    revalidateStableReleaseArtifacts({
      checksumOutput: resolvedChecksumOutput,
      checksumReceipt,
      snapshot,
      vsixOutput: resolvedVsixOutput,
      vsixReceipt
    });
    return Object.freeze({ checksumReceipt, vsixReceipt });
  } catch (error) {
    const cleanupErrors = [];
    for (const [path, receipt] of [
      [resolvedChecksumOutput, checksumReceipt],
      [resolvedVsixOutput, vsixReceipt]
    ]) {
      if (receipt !== undefined) {
        try {
          removeOwnedOutput(path, receipt);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    throw cleanupErrors.length === 0
      ? error
      : new AggregateError([error, ...cleanupErrors], "Stable release publication and cleanup failed.");
  }
}

function parseCliArguments(args) {
  if (args.length !== 5 || args[1] !== "--out" || args[3] !== "--checksum-out" || !args[0] || !args[2] || !args[4]) {
    throw new Error(
      "Pass one stable candidate plus explicit outputs: <candidate.vsix> --out <openwrangler.vsix> --checksum-out <openwrangler.vsix.sha256>."
    );
  }
  return { candidate: args[0], checksumOutput: args[4], vsixOutput: args[2] };
}

async function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const requested = parseCliArguments(process.argv.slice(2));
  const candidate = resolve(root, requested.candidate);
  const vsixOutput = resolve(root, requested.vsixOutput);
  const checksumOutput = resolve(root, requested.checksumOutput);
  if (new Set([candidate, vsixOutput, checksumOutput]).size !== 3) {
    throw new Error("Stable candidate, VSIX output, and checksum output must be three distinct paths.");
  }
  const snapshot = readOwnedVsixSnapshot(candidate);
  const packaged = await readStableVsixPayload(snapshot.bytes);
  const source = readReleaseSourceSnapshot({
    expectedCommit: process.env.EXPECTED_SHA,
    root
  });

  const problems = inspectStableReleaseReadiness({
    releaseTag: process.env.RELEASE_TAG,
    sourcePackageJson: source.files.get("package.json"),
    pythonVersionFile: source.files.get("python/openwrangler_runtime/version.py"),
    featureParity: source.files.get("docs/feature-parity.md"),
    changelog: source.files.get("CHANGELOG.md"),
    readme: source.files.get("README.md"),
    packagedPackageJson: packaged.packagedPackageJson,
    packagedPythonVersionFile: packaged.packagedPythonVersionFile,
    packagedReadme: packaged.packagedReadme,
    performanceReportFiles: source.files,
    performanceReportSourceCommit: source.commit,
    candidateSha256: snapshot.sha256,
    sourceCommit: source.commit,
    trackedEvidencePaths: source.trackedPaths,
    vsixManifest: packaged.vsixManifest
  });

  if (problems.length > 0) {
    throw new Error(`Stable release readiness failed for ${basename(candidate)}:\n- ${problems.join("\n- ")}`);
  }
  if (sha256(snapshot.bytes) !== snapshot.sha256) {
    throw new Error("Stable VSIX snapshot changed during readiness inspection.");
  }
  writeStableReleaseArtifacts({ checksumOutput, snapshot, vsixOutput });
  console.log(`Stable release readiness verified for ${basename(vsixOutput)} (${snapshot.sha256}).`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runCli();
}
