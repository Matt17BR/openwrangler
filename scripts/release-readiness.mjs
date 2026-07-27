import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SaxesParser } from "saxes";
import { inspectVsixPreReleaseMetadata } from "./vsix-contents.mjs";

const VSIX_MANIFEST_NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const NUMERIC_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const PYTHON_VERSION = /^__version__\s*=\s*"([^"\r\n]+)"\s*$/gmu;
const CHANGELOG_HEADING = /^## \[([^\]\r\n]+)\] - ([^\r\n]+)$/gmu;
const ISO_DATE = /^(?:0|[1-9]\d{3,})-(\d{2})-(\d{2})$/u;
const README_PREVIEW_CLAIMS = [
  { pattern: /\bactive preview\b/iu, label: 'README still describes Open Wrangler as an "active preview".' },
  {
    pattern: /\bprebuilt releases are not published yet\b/iu,
    label: "README still says that prebuilt releases are unavailable."
  },
  {
    pattern: /\bfuture preview builds?\b/iu,
    label: "README still directs users to future preview builds."
  },
  { pattern: /\bthis is a preview\b/iu, label: 'README still says "This is a preview".' }
];

function parseJsonObject(contents, label, problems) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    problems.push(`${label} must contain valid JSON.`);
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

function inspectPrimaryParityMatrix(contents) {
  const problems = [];
  const lines = contents.split(/\r?\n/u);
  const expectedHeader = ["Surface", "Pandas", "Polars", "Status", "Required evidence"];
  const headerIndex = lines.findIndex((line) => {
    const cells = splitMarkdownTableRow(line);
    return (
      cells !== undefined &&
      cells.length === expectedHeader.length &&
      cells.every((cell, index) => cell === expectedHeader[index])
    );
  });

  if (headerIndex < 0) {
    return ["docs/feature-parity.md is missing the canonical Pandas/Polars parity table."];
  }

  const separator = splitMarkdownTableRow(lines[headerIndex + 1] ?? "");
  if (
    separator === undefined ||
    separator.length !== expectedHeader.length ||
    separator.some((cell) => !/^:?-{3,}:?$/u.test(cell))
  ) {
    return ["The canonical Pandas/Polars parity table has a malformed separator row."];
  }

  let rowCount = 0;
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

    rowCount += 1;
    const [surface, pandas, polars, status] = cells;
    if (!surface || !pandas || !polars || !status) {
      problems.push(`The canonical Pandas/Polars parity table has an empty required cell at line ${index + 1}.`);
      continue;
    }
    if (!["Yes", "N/A"].includes(pandas) || !["Yes", "N/A"].includes(polars)) {
      problems.push(`Parity row "${surface}" has an invalid Pandas/Polars scope.`);
    }
    if (status !== "Done") {
      problems.push(`Parity row "${surface}" is ${status}, not Done.`);
    }
  }

  if (rowCount === 0) {
    problems.push("The canonical Pandas/Polars parity table must contain at least one release row.");
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
  const matches = [...contents.matchAll(CHANGELOG_HEADING)].filter((match) => match[1] === version);
  if (matches.length !== 1) {
    return [`CHANGELOG.md must contain exactly one heading for version ${version}.`];
  }
  const date = matches[0]?.[2]?.trim() ?? "";
  if (!isCalendarDate(date)) {
    return [`CHANGELOG.md version ${version} must use a real YYYY-MM-DD release date instead of "${date}".`];
  }
  return [];
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

  if (sourceVersion === undefined || !NUMERIC_VERSION.test(sourceVersion)) {
    problems.push("Source package.json version must use stable major.minor.patch syntax.");
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
  for (const claim of README_PREVIEW_CLAIMS) {
    if (claim.pattern.test(readme)) {
      problems.push(claim.label);
    }
    if (claim.pattern.test(packagedReadme)) {
      problems.push(claim.label.replace("README", "Packaged README"));
    }
  }

  if (packagedManifest?.preview !== false) {
    problems.push("Packaged package.json preview must be false for a stable release.");
  }
  for (const field of ["name", "displayName", "publisher", "version"]) {
    if (sourceManifest?.[field] !== packagedManifest?.[field]) {
      problems.push(`Packaged package.json ${field} does not match source package.json.`);
    }
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
