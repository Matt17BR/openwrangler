import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_INVARIANT_COUNT = 58;
const SOURCE_PATH = "AGENTS.md";
const ARCHIVE_PATH = "docs/contracts/invariants-v1.md";
const EVIDENCE_PATH = "docs/evidence/invariant-crosswalk.json";
const SCANNED_DOCUMENTS = ["docs/architecture.md", "docs/feature-parity.md", "docs/releasing.md", "docs/testing.md"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

export function extractInvariantSection(source) {
  const heading = /^## Non-negotiable invariants$/mu.exec(source);
  if (heading === null) {
    throw new Error("AGENTS.md is missing the Non-negotiable invariants section.");
  }

  const followingHeading = /^## /gmu;
  followingHeading.lastIndex = heading.index + heading[0].length;
  const next = followingHeading.exec(source);
  if (next === null) {
    throw new Error("AGENTS.md is missing a section after Non-negotiable invariants.");
  }

  const rawSection = source.slice(heading.index, next.index);
  return `${rawSection.replace(/\n+$/u, "")}\n`;
}

export function parseInvariantEntries(section, firstLine = 1) {
  const starts = [...section.matchAll(/^(?<id>[1-9]\d*)\. /gmu)];
  if (starts.length !== EXPECTED_INVARIANT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_INVARIANT_COUNT} invariants, found ${starts.length}. Invariant removal requires a reviewed contract migration.`
    );
  }

  const entries = starts.map((match, index) => {
    const id = Number(match.groups.id);
    const expectedId = index + 1;
    if (id !== expectedId) {
      throw new Error(`Invariant IDs must be contiguous: expected ${expectedId}, found ${id}.`);
    }

    const nextOffset = starts[index + 1]?.index ?? section.length;
    const text = section.slice(match.index, nextOffset).replace(/\n+$/u, "");
    const startLine = firstLine + lineNumberAt(section, match.index) - 1;
    const endLine = startLine + text.split("\n").length - 1;
    return { id, text, startLine, endLine, sha256: sha256(text) };
  });

  return entries;
}

function referencedInvariantIds(line) {
  const ids = [];
  for (const match of line.matchAll(/\binvariants?\s+(?<id>[1-9]\d*)\b/giu)) {
    const id = Number(match.groups.id);
    if (id < 1 || id > EXPECTED_INVARIANT_COUNT) {
      throw new Error(`Explicit reference points to unknown invariant ${id}.`);
    }
    ids.push(id);
  }
  return ids;
}

export function scanExplicitReferences(documents) {
  const references = new Map(Array.from({ length: EXPECTED_INVARIANT_COUNT }, (_, index) => [index + 1, []]));

  for (const path of Object.keys(documents).sort()) {
    const lines = documents[path].split("\n");
    lines.forEach((line, index) => {
      for (const id of referencedInvariantIds(line)) {
        const reference = { path, line: index + 1 };
        const current = references.get(id);
        if (!current.some((item) => item.path === reference.path && item.line === reference.line)) {
          current.push(reference);
        }
      }
    });
  }

  return references;
}

export function buildCrosswalk({ source, archive, documents }) {
  const section = extractInvariantSection(source);
  if (archive !== section) {
    throw new Error(`${ARCHIVE_PATH} is not a lossless copy of the current invariant block.`);
  }

  const sourceSectionOffset = source.indexOf(section);
  if (sourceSectionOffset < 0) {
    throw new Error("The extracted invariant block could not be located in AGENTS.md.");
  }
  const sourceFirstLine = lineNumberAt(source, sourceSectionOffset);
  const sourceEntries = parseInvariantEntries(section, sourceFirstLine);
  const archiveEntries = parseInvariantEntries(archive);
  const references = scanExplicitReferences(documents);

  const invariants = sourceEntries.map((entry, index) => {
    const archived = archiveEntries[index];
    if (archived.id !== entry.id || archived.sha256 !== entry.sha256) {
      throw new Error(`Invariant ${entry.id} differs between AGENTS.md and the archive.`);
    }
    return {
      id: entry.id,
      sha256: entry.sha256,
      sourceLines: { start: entry.startLine, end: entry.endLine },
      archiveLines: { start: archived.startLine, end: archived.endLine },
      explicitReferences: references.get(entry.id)
    };
  });

  return {
    schemaVersion: 1,
    generatedBy: "scripts/spec-invariants.mjs",
    authority: {
      path: SOURCE_PATH,
      section: "Non-negotiable invariants",
      sha256: sha256(section)
    },
    archive: { path: ARCHIVE_PATH, sha256: sha256(archive) },
    scannedDocuments: Object.keys(documents).sort(),
    invariantCount: invariants.length,
    invariants
  };
}

export function renderCrosswalk(crosswalk) {
  const placeholder = "__OPEN_WRANGLER_SCANNED_DOCUMENTS__";
  const rendered = JSON.stringify({ ...crosswalk, scannedDocuments: placeholder }, null, 2);
  const documents = `[${crosswalk.scannedDocuments.map((path) => JSON.stringify(path)).join(", ")}]`;
  return `${rendered.replace(`"${placeholder}"`, documents)}\n`;
}

async function readDocuments() {
  return Object.fromEntries(
    await Promise.all(SCANNED_DOCUMENTS.map(async (path) => [path, await readFile(resolve(root, path), "utf8")]))
  );
}

async function writeGeneratedFiles() {
  const source = await readFile(resolve(root, SOURCE_PATH), "utf8");
  const archive = extractInvariantSection(source);
  const documents = await readDocuments();
  const crosswalk = buildCrosswalk({ source, archive, documents });

  await mkdir(resolve(root, dirname(ARCHIVE_PATH)), { recursive: true });
  await mkdir(resolve(root, dirname(EVIDENCE_PATH)), { recursive: true });
  await writeFile(resolve(root, ARCHIVE_PATH), archive, "utf8");
  await writeFile(resolve(root, EVIDENCE_PATH), renderCrosswalk(crosswalk), "utf8");
}

export function assertGeneratedFilesCurrent({ source, archive, evidence, documents }) {
  const expected = renderCrosswalk(buildCrosswalk({ source, archive, documents }));
  if (evidence !== expected) {
    throw new Error(`${EVIDENCE_PATH} is stale. Run node scripts/spec-invariants.mjs --write.`);
  }
}

export async function checkGeneratedFiles() {
  const [source, archive, evidence, documents] = await Promise.all([
    readFile(resolve(root, SOURCE_PATH), "utf8"),
    readFile(resolve(root, ARCHIVE_PATH), "utf8"),
    readFile(resolve(root, EVIDENCE_PATH), "utf8"),
    readDocuments()
  ]);
  assertGeneratedFilesCurrent({ source, archive, evidence, documents });
}

async function main() {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length > 1 || (arguments_[0] !== undefined && !["--check", "--write"].includes(arguments_[0]))) {
    throw new Error("Usage: node scripts/spec-invariants.mjs [--check|--write]");
  }
  if (arguments_[0] === "--write") {
    await writeGeneratedFiles();
    return;
  }
  await checkGeneratedFiles();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
