import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertCleaningHistoryClaimsCurrent,
  assertGeneratedFilesCurrent,
  buildCrosswalk,
  checkCleaningHistoryClaims,
  checkGeneratedFiles,
  extractInvariantSection,
  parseCleaningHistoryCapabilityModel,
  parseInvariantEntries,
  renderCleaningHistoryClaims,
  renderCrosswalk,
  scanExplicitReferences
} from "./spec-invariants.mjs";

function fixtureSection(overrides = new Map()) {
  const entries = Array.from({ length: 58 }, (_, index) => {
    const id = index + 1;
    return overrides.get(id) ?? `${id}. Invariant ${id} text.`;
  });
  return `## Non-negotiable invariants\n\n${entries.join("\n")}\n`;
}

function cleaningHistoryModel() {
  return {
    schemaVersion: 1,
    capabilities: [
      { id: "inspect", status: "implemented", scope: "any_committed_step" },
      { id: "edit", status: "implemented", scope: "any_committed_step" },
      { id: "delete", status: "implemented", scope: "any_committed_step" },
      { id: "undo", status: "implemented", scope: "most_recent_committed_step" },
      { id: "reorder", status: "not_committed", scope: "committed_steps" }
    ]
  };
}

function cleaningHistoryDocuments(model) {
  const claims = renderCleaningHistoryClaims(model);
  return {
    "README.md": `# README\n\n## Transformations\n\n${claims.readme.join(" ")}\n\n## Notebook workflows\n`,
    "docs/product-roadmap.md": `# Roadmap\n\n### P1: fidelity and daily use\n\n${claims.roadmap.join(
      " "
    )}\n\n### P2: next\n\n## Audit disposition\n\n${claims.roadmap.join(" ")}\n\n## Evidence\n`
  };
}

test("extractInvariantSection preserves the complete invariant block", () => {
  const section = fixtureSection(new Map([[57, "57. First line.\n    Continued line."]]));
  const source = `# Guide\n\n${section}\n## Public writing\n`;

  assert.equal(extractInvariantSection(source), section);
  const entries = parseInvariantEntries(section, 10);
  assert.equal(entries.length, 58);
  assert.equal(entries[56].text, "57. First line.\n    Continued line.");
  assert.deepEqual({ start: entries[56].startLine, end: entries[56].endLine }, { start: 68, end: 69 });
});

test("parseInvariantEntries rejects missing or reordered IDs", () => {
  const section = fixtureSection().replace("17. Invariant 17 text.", "18. Invariant 17 text.");
  assert.throws(() => parseInvariantEntries(section), /expected 17, found 18/u);
});

test("buildCrosswalk rejects a changed archive", () => {
  const section = fixtureSection();
  const source = `# Guide\n\n${section}\n## Public writing\n`;
  const archive = section.replace("Invariant 8 text.", "Changed invariant 8 text.");
  assert.throws(() => buildCrosswalk({ source, archive, documents: {} }), /not a lossless copy/u);
});

test("the repository archive and crosswalk match their authoritative inputs", async () => {
  await assert.doesNotReject(checkGeneratedFiles());
});

test("the cleaning-history registry drives every current claim surface", async () => {
  const model = parseCleaningHistoryCapabilityModel(JSON.stringify(cleaningHistoryModel()));
  assert.deepEqual(
    model.capabilities.map(({ id }) => id),
    ["inspect", "edit", "delete", "undo", "reorder"]
  );
  assert.deepEqual(renderCleaningHistoryClaims(model), {
    readme: [
      "Any applied step can be inspected, edited, or deleted.",
      "Cleaning Undo removes the most recent committed step.",
      "Reordering committed steps is not supported."
    ],
    roadmap: [
      "Any committed step can be inspected, edited, or deleted.",
      "Cleaning Undo removes the most recent committed step.",
      "Reordering committed steps has no product commitment."
    ]
  });
  await assert.doesNotReject(checkCleaningHistoryClaims());
});

test("the cleaning-history validator reproduces the audited latest-step contradiction", async () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  const contradiction = JSON.parse(
    await readFile(new URL("../fixtures/cleaning-history-claim-contradiction.json", import.meta.url), "utf8")
  );
  assert.equal(contradiction.schemaVersion, 1);
  assert.ok(documents["docs/product-roadmap.md"].includes(contradiction.roadmapClaim));
  documents["README.md"] = documents["README.md"].replace(
    "Any applied step can be inspected, edited, or deleted.",
    contradiction.readmeReplacement
  );

  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        documents
      }),
    /README\.md ## Transformations must contain the generated claim exactly once/u
  );
});

test("each cleaning-history capability is mutation-sensitive", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);

  for (const id of ["inspect", "edit", "delete", "undo", "reorder"]) {
    const mutant = structuredClone(model);
    const capability = mutant.capabilities.find((entry) => entry.id === id);
    capability.status = capability.status === "implemented" ? "not_committed" : "implemented";
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(mutant),
          documents
        }),
      /must contain the generated claim exactly once/u,
      `${id} mutation must invalidate the checked claims`
    );
  }
});

test("the cleaning-history model is bounded and keeps capability identities distinct", () => {
  assert.throws(
    () => parseCleaningHistoryCapabilityModel(" ".repeat(8 * 1024 + 1)),
    /exceeds the 8192-byte validation limit/u
  );

  const duplicate = cleaningHistoryModel();
  duplicate.capabilities[1].id = "inspect";
  assert.throws(
    () => parseCleaningHistoryCapabilityModel(JSON.stringify(duplicate)),
    /capability 2 must be edit, found inspect/u
  );
});

test("the generated-file check rejects stale archive and evidence bytes", () => {
  const archive = fixtureSection();
  const source = `# Guide\n\n${archive}\n## Public writing\n`;
  const documents = { "docs/testing.md": "See invariant 4.\n" };
  const evidence = renderCrosswalk(buildCrosswalk({ source, archive, documents }));

  assert.throws(
    () =>
      assertGeneratedFilesCurrent({
        source,
        archive: archive.replace("Invariant 8 text.", "Changed invariant 8 text."),
        evidence,
        documents
      }),
    /not a lossless copy/u
  );
  assert.throws(
    () => assertGeneratedFilesCurrent({ source, archive, evidence: `${evidence} `, documents }),
    /is stale/u
  );
});

test("scanExplicitReferences records only numbered references", () => {
  const references = scanExplicitReferences({
    "docs/testing.md": "Invariant core is not numbered.\nSee invariant 4 and invariant 40.\n"
  });

  assert.deepEqual(references.get(4), [{ path: "docs/testing.md", line: 2 }]);
  assert.deepEqual(references.get(40), [{ path: "docs/testing.md", line: 2 }]);
  assert.deepEqual(references.get(1), []);
});

test("the rendered crosswalk is deterministic and covers every invariant", () => {
  const archive = fixtureSection();
  const source = `# Guide\n\n${archive}\n## Public writing\n`;
  const documents = {
    "docs/testing.md": "See invariant 4.\n",
    "docs/architecture.md": "See invariant 40.\n"
  };

  const first = buildCrosswalk({ source, archive, documents });
  const second = buildCrosswalk({ source, archive, documents });
  assert.equal(renderCrosswalk(first), renderCrosswalk(second));
  assert.equal(first.invariantCount, 58);
  assert.deepEqual(first.scannedDocuments, ["docs/architecture.md", "docs/testing.md"]);
  assert.deepEqual(
    first.invariants.map(({ id }) => id),
    Array.from({ length: 58 }, (_, index) => index + 1)
  );
});
