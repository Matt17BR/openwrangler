import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SaxesParser } from "saxes";
import { NUMERIC_RELEASE_VERSION } from "./release-metadata.mjs";
import { DuplicateJsonKeyError, parseStrictJson } from "./strict-json.mjs";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const VSIX_MANIFEST_NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const PYTHON_VERSION = /^__version__\s*=\s*"([^"\r\n]+)"\s*$/gmu;
const CHANGELOG_HEADING = /^## \[([^\]\r\n]+)\] - ([^\r\n]+)$/u;
const ISO_DATE = /^(?:0|[1-9]\d{3,})-(\d{2})-(\d{2})$/u;
const FEATURE_PARITY_HEADING = "# Feature parity matrix";
const README_RELEASE_SECTION_START = "<!-- open-wrangler-release-status:start -->";
const README_RELEASE_SECTION_END = "<!-- open-wrangler-release-status:end -->";
const README_MAX_BYTES = 2 * 1024 * 1024;
export const STABLE_README_RELEASE_SECTION = `${README_RELEASE_SECTION_START}
> **Release status:** Stable. Install the checksummed VSIX from [GitHub Releases](https://github.com/Matt17BR/openwrangler/releases).
${README_RELEASE_SECTION_END}`;
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
  ["Missing/duplicate row operations", "Yes", "Yes"],
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

function stripHtmlComments(line, state) {
  let cursor = 0;
  let active = "";
  while (cursor < line.length) {
    if (state.inComment) {
      const close = line.indexOf("-->", cursor);
      if (close < 0) {
        return active;
      }
      state.inComment = false;
      cursor = close + 3;
      continue;
    }

    const open = line.indexOf("<!--", cursor);
    if (open < 0) {
      active += line.slice(cursor);
      return active;
    }
    active += line.slice(cursor, open);
    state.inComment = true;
    cursor = open + 4;
  }
  return active;
}

function activeMarkdownLines(contents) {
  const comment = { inComment: false };
  let fence;
  return contents.split(/\r?\n/u).map((rawLine) => {
    if (fence !== undefined) {
      const closing = /^ {0,3}(`+|~+)[\t ]*$/u.exec(rawLine);
      if (closing !== null && closing[1]?.[0] === fence.character && (closing[1]?.length ?? 0) >= fence.length) {
        fence = undefined;
      }
      return "";
    }

    const line = stripHtmlComments(rawLine, comment);
    const opening = /^ {0,3}(`{3,}|~{3,}).*$/u.exec(line);
    if (opening !== null) {
      fence = { character: opening[1]?.[0], length: opening[1]?.length ?? 0 };
      return "";
    }
    if (/^(?: {4}|\t)/u.test(line)) {
      return "";
    }
    return line;
  });
}

function splitMarkdownTableRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
    return undefined;
  }
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function hasSubstantiveEvidence(evidence) {
  const normalized = evidence
    .replace(/[`*_~]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length < 8 || !/[\p{L}\p{N}]/u.test(normalized)) {
    return false;
  }
  if (/^(?:n\/?a|none|unknown|todo|tbd|pending|planned|placeholder)[.!]?$/iu.test(normalized)) {
    return false;
  }
  return !/^(?:add|complete|enforce|finish|record|todo|tbd)\b/iu.test(normalized);
}

function inspectPrimaryParityMatrix(contents) {
  const problems = [];
  const lines = activeMarkdownLines(contents);
  const expectedHeader = ["Surface", "Pandas", "Polars", "Status", "Required evidence"];
  const firstActiveLine = lines.find((line) => line.trim().length > 0)?.trim();
  if (firstActiveLine !== FEATURE_PARITY_HEADING) {
    problems.push(`docs/feature-parity.md must begin with "${FEATURE_PARITY_HEADING}".`);
  }
  const headerIndices = lines.flatMap((line, index) => {
    const cells = splitMarkdownTableRow(line);
    return cells !== undefined &&
      cells.length === expectedHeader.length &&
      cells.every((cell, cellIndex) => cell === expectedHeader[cellIndex])
      ? [index]
      : [];
  });
  if (headerIndices.length === 0) {
    return ["docs/feature-parity.md is missing the canonical Pandas/Polars parity table."];
  }
  if (headerIndices.length !== 1) {
    return [
      `docs/feature-parity.md must contain exactly one active canonical Pandas/Polars parity table; found ${headerIndices.length}.`
    ];
  }
  const headerIndex = headerIndices[0] ?? -1;
  const firstSectionIndex = lines.findIndex((line) => /^##(?:\s|$)/u.test(line.trim()));
  if (firstSectionIndex >= 0 && headerIndex > firstSectionIndex) {
    problems.push("The canonical Pandas/Polars parity table must remain in the top-level feature-parity section.");
  }

  const separator = splitMarkdownTableRow(lines[headerIndex + 1] ?? "");
  if (
    separator === undefined ||
    separator.length !== expectedHeader.length ||
    separator.some((cell) => !/^:?-{3,}:?$/u.test(cell))
  ) {
    return ["The canonical Pandas/Polars parity table has a malformed separator row."];
  }

  const rows = [];
  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      break;
    }
    const cells = splitMarkdownTableRow(line);
    if (cells === undefined || cells.length !== expectedHeader.length) {
      problems.push(`The canonical Pandas/Polars parity table has a malformed row at line ${index + 1}.`);
      continue;
    }

    rows.push({ cells, line: index + 1 });
    const [surface, pandas, polars, status, evidence] = cells;
    if (!surface || !pandas || !polars || !status || !evidence) {
      problems.push(`The canonical Pandas/Polars parity table has an empty required cell at line ${index + 1}.`);
      continue;
    }
    if (status !== "Done") {
      problems.push(`Parity row "${surface}" is ${status}, not Done.`);
    } else if (!hasSubstantiveEvidence(evidence)) {
      problems.push(`Parity row "${surface}" must record substantive completed acceptance evidence.`);
    }
  }

  if (rows.length !== PRIMARY_PARITY_SCOPE.length) {
    problems.push(
      `The canonical Pandas/Polars parity table must contain exactly ${PRIMARY_PARITY_SCOPE.length} release rows; found ${rows.length}.`
    );
  }
  const comparisonLength = Math.max(rows.length, PRIMARY_PARITY_SCOPE.length);
  for (let index = 0; index < comparisonLength; index += 1) {
    const actual = rows[index];
    const expected = PRIMARY_PARITY_SCOPE[index];
    if (expected === undefined) {
      problems.push(`Unexpected parity row "${actual?.cells[0] ?? ""}" at position ${index + 1}.`);
      continue;
    }
    if (actual === undefined) {
      problems.push(`Missing parity row "${expected[0]}" at position ${index + 1}.`);
      continue;
    }

    const [surface, pandas, polars] = actual.cells;
    if (surface !== expected[0] || pandas !== expected[1] || polars !== expected[2]) {
      problems.push(
        `Parity row ${index + 1} must be "${expected[0]}" (${expected[1]}/${expected[2]}), received "${surface}" (${pandas}/${polars}) at line ${actual.line}.`
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

function inspectChangelog(contents, version) {
  const lines = activeMarkdownLines(contents);
  const firstActiveLine = lines.find((line) => line.trim().length > 0)?.trim();
  if (firstActiveLine !== "# Changelog") {
    return ['CHANGELOG.md must begin with the active Markdown heading "# Changelog".'];
  }
  const matches = lines.map((line) => CHANGELOG_HEADING.exec(line.trim())).filter((match) => match?.[1] === version);
  if (matches.length !== 1) {
    return [`CHANGELOG.md must contain exactly one heading for version ${version}.`];
  }
  const date = matches[0]?.[2]?.trim() ?? "";
  if (!isCalendarDate(date)) {
    return [`CHANGELOG.md version ${version} must use a real YYYY-MM-DD release date instead of "${date}".`];
  }
  return [];
}

function inspectStableReadme(contents, label) {
  if (Buffer.byteLength(contents, "utf8") > README_MAX_BYTES) {
    return [`${label} exceeds the bounded stable-release documentation size.`];
  }
  const normalized = contents.replace(/\r\n?/gu, "\n");
  const starts = normalized.split(README_RELEASE_SECTION_START).length - 1;
  const ends = normalized.split(README_RELEASE_SECTION_END).length - 1;
  if (starts !== 1 || ends !== 1 || !normalized.includes(STABLE_README_RELEASE_SECTION)) {
    return [`${label} must contain exactly one canonical stable release/install-status section.`];
  }
  const start = normalized.indexOf(README_RELEASE_SECTION_START);
  const end = normalized.indexOf(README_RELEASE_SECTION_END, start);
  const actual = normalized.slice(start, end + README_RELEASE_SECTION_END.length);
  return actual === STABLE_README_RELEASE_SECTION
    ? []
    : [`${label} must contain exactly one canonical stable release/install-status section.`];
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

export function inspectStableReleaseReadiness({
  releaseTag,
  sourcePackageJson,
  pythonVersionFile,
  featureParity,
  changelog,
  readme,
  packagedPackageJson,
  packagedPythonVersionFile,
  packagedReadme,
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

  if (sourceVersion === undefined || !NUMERIC_RELEASE_VERSION.test(sourceVersion)) {
    problems.push("Source package.json version must use stable major.minor.patch syntax.");
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
  problems.push(...inspectPrimaryParityMatrix(featureParity));
  problems.push(...inspectStableReadme(readme, "README.md"));
  problems.push(...inspectStableReadme(packagedReadme, "Packaged README"));

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

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const requested = process.argv[2];
  if (!requested) {
    throw new Error("Pass the exact stable VSIX path to inspect; implicit artifact selection is disabled.");
  }
  const vsix = resolve(root, requested);
  if (!existsSync(vsix)) {
    throw new Error(`Stable VSIX not found: ${requested}`);
  }

  const problems = inspectStableReleaseReadiness({
    releaseTag: process.env.RELEASE_TAG,
    sourcePackageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    pythonVersionFile: readFileSync(resolve(root, "python/openwrangler_runtime/version.py"), "utf8"),
    featureParity: readFileSync(resolve(root, "docs/feature-parity.md"), "utf8"),
    changelog: readFileSync(resolve(root, "CHANGELOG.md"), "utf8"),
    readme: readFileSync(resolve(root, "README.md"), "utf8"),
    packagedPackageJson: execFileSync("unzip", ["-p", vsix, "extension/package.json"], { encoding: "utf8" }),
    packagedPythonVersionFile: execFileSync("unzip", ["-p", vsix, "extension/python/openwrangler_runtime/version.py"], {
      encoding: "utf8"
    }),
    packagedReadme: execFileSync("unzip", ["-p", vsix, "extension/readme.md"], { encoding: "utf8" }),
    vsixManifest: execFileSync("unzip", ["-p", vsix, "extension.vsixmanifest"], { encoding: "utf8" })
  });

  if (problems.length > 0) {
    throw new Error(`Stable release readiness failed for ${basename(vsix)}:\n- ${problems.join("\n- ")}`);
  }
  console.log(`Stable release readiness verified for ${basename(vsix)}.`);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
