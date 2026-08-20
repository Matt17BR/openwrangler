import assert from "node:assert/strict";
import { link, mkdtemp, open as openFile, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  assertCleaningHistoryClaimsCurrent,
  assertGeneratedFilesCurrent,
  buildCrosswalk,
  checkCleaningHistoryClaims,
  checkGeneratedFiles,
  extractInvariantSection,
  parseCleaningHistoryCapabilityModel,
  parseCleaningHistoryProductionAuthority,
  parseInvariantEntries,
  readBoundedUtf8File,
  renderCleaningHistoryClaimBlock,
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

function cleaningHistoryProductionAuthoritySource(model = cleaningHistoryModel()) {
  const entries = model.capabilities.map(
    (capability, index) =>
      `  ${capability.id}: Object.freeze({ status: "${capability.status}", scope: "${capability.scope}" })${
        index === model.capabilities.length - 1 ? "" : ","
      }`
  );
  return [
    "export type Unrelated = string;",
    "// cleaning-history-capability-authority:start",
    "export const CLEANING_HISTORY_CAPABILITY_AUTHORITY = Object.freeze({",
    ...entries,
    "});",
    "// cleaning-history-capability-authority:end"
  ].join("\n");
}

function cleaningHistoryDocuments(model) {
  const claims = renderCleaningHistoryClaims(model);
  return {
    "README.md": [
      "# README",
      "",
      "## Transformations",
      "",
      renderCleaningHistoryClaimBlock("readme-transformations", claims.readme),
      "",
      "## Notebook workflows",
      "",
      renderCleaningHistoryClaimBlock("readme-native-r", claims.readme),
      "",
      "## Export"
    ].join("\n"),
    "docs/product-roadmap.md": [
      "# Roadmap",
      "",
      "### P1: fidelity and daily use",
      "",
      renderCleaningHistoryClaimBlock("roadmap-p1", claims.roadmap),
      "",
      "### P2: next",
      "",
      "## Audit disposition",
      "",
      renderCleaningHistoryClaimBlock("roadmap-audit", claims.roadmap),
      "",
      "## Evidence"
    ].join("\n")
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
  const productionAuthority = parseCleaningHistoryProductionAuthority(cleaningHistoryProductionAuthoritySource());
  assert.deepEqual(productionAuthority, model);
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
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      }),
    /readme-transformations claim block must exclusively match/u
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
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /must match the production authority/u,
      `${id} mutation must invalidate the checked claims`
    );
  }
});

test("self-consistent semantic claim mutants still fail against production behavior", () => {
  const productionAuthoritySource = cleaningHistoryProductionAuthoritySource();
  const mutants = [
    ["edit", { status: "implemented", scope: "latest_committed_step" }],
    ["delete", { status: "implemented", scope: "latest_committed_step" }],
    ["undo", { status: "implemented", scope: "any_committed_step" }],
    ["reorder", { status: "implemented", scope: "committed_steps" }]
  ];

  for (const [id, replacement] of mutants) {
    const mutant = cleaningHistoryModel();
    Object.assign(
      mutant.capabilities.find((capability) => capability.id === id),
      replacement
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(mutant),
          productionAuthoritySource,
          documents: cleaningHistoryDocuments(mutant)
        }),
      /must match the production authority/u,
      `${id} model and prose must not override the product authority together`
    );
  }
});

test("every cleaning-history claim block rejects additive contradictory prose", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  const surfaces = [
    ["README.md", "readme-transformations"],
    ["README.md", "readme-native-r"],
    ["docs/product-roadmap.md", "roadmap-p1"],
    ["docs/product-roadmap.md", "roadmap-audit"]
  ];

  for (const [path, marker] of surfaces) {
    const mutantDocuments = structuredClone(documents);
    mutantDocuments[path] = mutantDocuments[path].replace(
      `<!-- cleaning-history-capabilities:${marker}:end -->`,
      `Only the latest committed step can be edited.\n<!-- cleaning-history-capabilities:${marker}:end -->`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents: mutantDocuments
        }),
      new RegExp(`${marker} claim block must exclusively match`, "u")
    );
  }
});

test("cleaning-history claim surfaces reject contradictory prose outside their exclusive blocks", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  const surfaces = [
    ["README.md", "readme-transformations"],
    ["README.md", "readme-native-r"],
    ["docs/product-roadmap.md", "roadmap-p1"],
    ["docs/product-roadmap.md", "roadmap-audit"]
  ];

  for (const [path, marker] of surfaces) {
    const mutantDocuments = structuredClone(documents);
    mutantDocuments[path] = mutantDocuments[path].replace(
      `<!-- cleaning-history-capabilities:${marker}:end -->`,
      `<!-- cleaning-history-capabilities:${marker}:end -->\nOnly the latest committed step can be edited.`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents: mutantDocuments
        }),
      /contradictory cleaning-history capability claim outside its exclusive claim block/u
    );
  }
});

test("cleaning-history claim surfaces ignore fenced examples but reject equivalent visible contradictions", () => {
  const model = cleaningHistoryModel();
  const examples = [
    "Editing is limited to the newest committed step.",
    "Earlier applied steps cannot be modified or removed.",
    "You cannot edit older applied steps.",
    "Inspection of earlier applied steps is unavailable.",
    "Undo can remove any committed step.",
    "Committed steps may be re-arranged.",
    "Reordering is supported.",
    "Cleaning history ordering can be changed."
  ];

  for (const example of examples) {
    const fenced = cleaningHistoryDocuments(model);
    fenced["README.md"] = fenced["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n\`\`\`text\n${example}\n\`\`\``
    );
    assert.doesNotThrow(() =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents: fenced
      })
    );

    const visible = cleaningHistoryDocuments(model);
    visible["README.md"] = visible["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents: visible
        }),
      /contradictory cleaning-history capability claim/u,
      example
    );
  }
});

test("cleaning-history Markdown headings and claim markers inside fences are not structural", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = [
    "```markdown",
    "## Transformations",
    "<!-- cleaning-history-capabilities:readme-transformations:start -->",
    "Only the latest applied step can be edited.",
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    "```",
    documents["README.md"]
  ].join("\n");
  assert.doesNotThrow(() =>
    assertCleaningHistoryClaimsCurrent({
      modelSource: JSON.stringify(model),
      productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
      documents
    })
  );
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

  assert.throws(
    () => parseCleaningHistoryCapabilityModel('{"schemaVersion":1,"schemaVersion":1,"capabilities":[]}'),
    /duplicate JSON key "schemaVersion"/u
  );
  assert.throws(
    () => parseCleaningHistoryCapabilityModel('{"schemaVersion":1,"capabilities":[],"nested":{"a":1,"a":2}}'),
    /duplicate JSON key "a"/u
  );
  assert.throws(
    () => parseCleaningHistoryCapabilityModel('{"schemaVersion":1,"capabilities":[],"nested":{"a":1,"\\u0061":2}}'),
    /duplicate JSON key "a"/u
  );
});

test("the cleaning-history JSON scanner enforces entry, depth, and text budgets before native parsing", () => {
  const tooManyEntries = `{${Array.from({ length: 65 }, (_, index) => `"k${index}":null`).join(",")}}`;
  assert.throws(
    () => parseCleaningHistoryCapabilityModel(tooManyEntries),
    /object with more than 64 entries|more than 128 total entries/u
  );
  assert.throws(
    () => parseCleaningHistoryCapabilityModel(`${"[".repeat(9)}null${"]".repeat(9)}`),
    /maximum JSON depth of 8/u
  );
  assert.throws(
    () => parseCleaningHistoryCapabilityModel(`{"value":"${"x".repeat(513)}"}`),
    /string over 512 UTF-8 bytes/u
  );
});

test("bounded cleaning-history reads reject hostile size before decoding the complete file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-bound-"));
  const path = join(directory, "oversized.json");
  const handle = await openFile(path, "w");
  try {
    await handle.truncate(8 * 1024 + 1);
  } finally {
    await handle.close();
  }
  try {
    await assert.rejects(readBoundedUtf8File(path, 8 * 1024, "hostile model"), /exceeds the 8192-byte/u);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("bounded cleaning-history reads reject symlinks and hard-link aliases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-identity-"));
  const source = join(directory, "source.json");
  const symbolicAlias = join(directory, "symbolic.json");
  const hardAlias = join(directory, "hard.json");
  try {
    await writeFile(source, "{}", { encoding: "utf8", mode: 0o600 });
    await symlink(source, symbolicAlias);
    await assert.rejects(
      readBoundedUtf8File(symbolicAlias, 8 * 1024, "symbolic model"),
      /regular file, not a symbolic link or special file/u
    );

    await link(source, hardAlias);
    await assert.rejects(readBoundedUtf8File(hardAlias, 8 * 1024, "hard-linked model"), /exactly one hard link/u);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test(
  "bounded cleaning-history reads reject a FIFO before allocating a read buffer",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-fifo-"));
    const path = join(directory, "model.pipe");
    try {
      const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      await assert.rejects(
        readBoundedUtf8File(path, 8 * 1024, "FIFO model"),
        /regular file, not a symbolic link or special file/u
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

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
