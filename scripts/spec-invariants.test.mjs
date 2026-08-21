import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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

test("cleaning-history structural claims reject synonym and word-order contradictions", () => {
  const model = cleaningHistoryModel();
  const examples = [
    "Modification of the final applied operation is the sole form supported.",
    "The prior transformation is read-only and cannot be revised.",
    "Amending a preceding plan entry is impossible.",
    "Rollback is available for a specifically chosen committed plan entry.",
    "Every committed operation can be restored independently.",
    "A selected older applied operation is reversible through Undo.",
    "Undo can restore the committed step of your choice.",
    "Pick which committed step to undo.",
    "Choose a committed step to undo.",
    "Target whichever committed operation for rollback.",
    "Plan entries have a mutable sequence.",
    "You may rearrange the applied workflow.",
    "Shuffling the cleaning plan is offered."
  ];
  for (const example of examples) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /contradictory cleaning-history capability claim/u,
      example
    );
  }
});

test("cleaning-history claims use rendered inline Markdown and decoded entity text", () => {
  const model = cleaningHistoryModel();
  const examples = [
    "Only the `latest` committed step can be **edited**.",
    "Earlier *applied steps* cannot be mod&#x69;fied or removed.",
    "Undo can remove any&nbsp;committed step.",
    "Committed steps may be re&#x2d;arranged.",
    "Earlier applied steps cannot be non‑latest targets for editing.",
    "The non&#x2011;latest committed step cannot be edited.",
    "Only the lat\u200best committed step can be edited.",
    "Only the lat&#x200b;est committed step can be edited.",
    "Earlier applied steps cannot be mod&shy;ified.",
    "Earlier applied steps can’t be modified.",
    "Only the [lat**est** committed step](#cleaning-history) can be *ed**it**ed*.",
    "![Only the lat&shy;est **committed** step can be edited](#cleaning-history)"
  ];
  for (const example of examples) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /contradictory cleaning-history capability claim/u,
      example
    );
  }
});

test("cleaning-history claims accept truthful prose about unrelated editable and ordered surfaces", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = documents["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "Only the latest generated report is editable before publication.",
      "Undo keyboard shortcuts are unavailable while an input is focused.",
      "The renderer can reorder table rows in an example.",
      "The previous workflow can be inspected in logs.",
      "Only the latest browser-history entry can be edited.",
      "Use `Committed steps may be reordered` only as a rejected-input example."
    ].join("\n")
  );
  assert.doesNotThrow(() =>
    assertCleaningHistoryClaimsCurrent({
      modelSource: JSON.stringify(model),
      productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
      documents
    })
  );
});

test("cleaning-history claims bind Undo targets and restrictions to their semantic clause", () => {
  const model = cleaningHistoryModel();
  const truthful = [
    "Undo targets only the most recent committed step.",
    "Undo applies to no other committed step than the latest one.",
    "Every committed step remains editable, while Undo targets the most recent committed step.",
    "Inspection can target any committed step and Undo affects only the latest committed step.",
    "Undo targets the most recent committed step—while inspection can target any committed step."
  ];
  const contradictions = [
    "Undo can restore each committed step.",
    "Undo can restore any other committed step.",
    "Undo can restore a changed committed step.",
    "Undo—can remove any committed step.",
    "Undo is not limited to the latest committed step."
  ];

  for (const example of truthful) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.doesNotThrow(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      example
    );
  }

  for (const example of contradictions) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /contradictory cleaning-history capability claim/u,
      example
    );
  }
});

test("cleaning-history universal and restrictive wording cannot hide capability contradictions", () => {
  const model = cleaningHistoryModel();
  const contradictions = [
    "All committed steps can be undone.",
    "Both committed steps may be restored by Undo.",
    "Multiple applied steps can be restored.",
    "Just the latest applied step can be edited.",
    "Only one committed step can be modified.",
    "Just two committed steps can be edited.",
    "Not every committed step can be edited.",
    "Not all committed steps can be edited.",
    "Both committed steps cannot be edited.",
    "Multiple committed steps cannot be edited.",
    "No other committed step can be edited.",
    "All but one committed step can be edited.",
    "Every committed step except the latest can be edited.",
    "All but the latest committed step can be undone.",
    "Undo can restore all of them.",
    "They can both be undone.",
    "The committed steps remain visible and both can be undone.",
    "The committed steps remain visible and they cannot all be edited.",
    "`All` committed steps can be **undone**.",
    "Undo can restore [both of them](#cleaning-history).",
    "Not e&#118;ery committed step can be *edited*.",
    "No **other** committed step can be ed&#x69;ted."
  ];

  for (const example of contradictions) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /contradictory cleaning-history capability claim/u,
      example
    );
  }
});

test("cleaning-history wording preserves exact latest Undo and native single-invocation scope", () => {
  const model = cleaningHistoryModel();
  const truthful = [
    "All committed steps can be inspected, edited, or deleted.",
    "Both native Edit and Delete actions operate on one selected committed step per invocation.",
    "Multiple committed steps may be edited in one plan.",
    "The native Edit command changes just one selected committed step per invocation.",
    "One selected committed step can be edited at a time.",
    "Undo is available only for the most recent committed step.",
    "The native Undo command targets just the latest committed step.",
    "Both the native menu and toolbar expose Undo only for the latest committed step.",
    "All native surfaces expose Undo only for the latest committed step.",
    "Multiple native surfaces expose Undo only for the latest committed step."
  ];

  for (const example of truthful) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${example}`
    );
    assert.doesNotThrow(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      example
    );
  }
});

test("a code example cannot hide a separate rendered inline contradiction", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = documents["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "Use `Committed steps may be reordered` as a rejected-input example, but only the `latest` committed step can be edited."
    ].join("\n")
  );
  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      }),
    /contradictory cleaning-history capability claim/u
  );
});

test("an example exemption belongs only to its exact inline code span", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = documents["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "Use `Only the latest committed step can be edited` as a rejected-input example and `Undo any committed step` in one clause."
    ].join("\n")
  );
  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      }),
    /contradictory cleaning-history capability claim/u
  );
});

test("cleaning-history claims fail closed on unresolved visible named entities", () => {
  const model = cleaningHistoryModel();
  for (const text of [
    "Earlier applied steps cannot be mod&amp;shy;ified.",
    "Earlier applied steps cannot be mod&notARealEntity;ified.",
    "Earlier applied steps cannot be mod&a;ified.",
    "![Earlier applied steps cannot be mod&a;ified](#cleaning-history)"
  ]) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace(
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${text}`
    );
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /unresolved visible named Markdown entity/u
    );
  }
});

test("cleaning-history inline classification fails closed before an unbounded token rescan", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = documents["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    `<!-- cleaning-history-capabilities:readme-transformations:end -->\n${"`sample` ".repeat(4097)}`
  );
  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      }),
    /more than 4096 visible inline Markdown tokens/u
  );
});

test("cleaning-history structural claims preserve valid code examples but reject malformed fences", () => {
  const model = cleaningHistoryModel();
  const valid = cleaningHistoryDocuments(model);
  valid["README.md"] = valid["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "```markdown title=legacy",
      "Only the latest step can be edited.",
      "```",
      "",
      "    Undo can remove any committed step.",
      "",
      "Use `Committed steps may be reordered` only as a rejected-input example."
    ].join("\n")
  );
  assert.doesNotThrow(() =>
    assertCleaningHistoryClaimsCurrent({
      modelSource: JSON.stringify(model),
      productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
      documents: valid
    })
  );

  const malformed = cleaningHistoryDocuments(model);
  malformed["README.md"] = malformed["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "```bad`info",
      "Editing committed operations is restricted to the newest one.",
      "```"
    ].join("\n")
  );
  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents: malformed
      }),
    /contradictory cleaning-history capability claim/u
  );
});

test("cleaning-history structural claims reject duplicate visible sections", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] += "\n## Transformations\n\nA second visible section.\n";
  assert.throws(
    () =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      }),
    /exactly one ## Transformations heading/u
  );
});

test("cleaning-history section ownership recognizes Setext and entity-encoded headings", () => {
  const model = cleaningHistoryModel();
  for (const replacement of ["Trans*formations*\n-----------------", "## Trans&#102;ormations"]) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] = documents["README.md"].replace("## Transformations", replacement);
    assert.doesNotThrow(() =>
      assertCleaningHistoryClaimsCurrent({
        modelSource: JSON.stringify(model),
        productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
        documents
      })
    );
  }

  const linked = cleaningHistoryDocuments(model);
  linked["README.md"] = linked["README.md"]
    .replace("## Transformations", "[Trans**for**mations][transformations]\n-----------------")
    .concat("\n[transformations]: #transformations\n");
  assert.doesNotThrow(() =>
    assertCleaningHistoryClaimsCurrent({
      modelSource: JSON.stringify(model),
      productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
      documents: linked
    })
  );

  for (const duplicate of ["Transformations\n---------------", "## Trans&#102;ormations"]) {
    const documents = cleaningHistoryDocuments(model);
    documents["README.md"] += `\n${duplicate}\n\nA second visible section.\n`;
    assert.throws(
      () =>
        assertCleaningHistoryClaimsCurrent({
          modelSource: JSON.stringify(model),
          productionAuthoritySource: cleaningHistoryProductionAuthoritySource(),
          documents
        }),
      /exactly one ## Transformations heading/u
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

test(
  "bounded cleaning-history reads reject hostile size before decoding the complete file",
  { skip: process.platform !== "linux" },
  async () => {
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
  }
);

test(
  "bounded cleaning-history reads reject symlinks and hard-link aliases",
  { skip: process.platform !== "linux" },
  async () => {
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
  }
);

test("bounded cleaning-history reads reject a symlinked ancestor", { skip: process.platform !== "linux" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-ancestor-"));
  const realDirectory = join(directory, "real");
  const aliasDirectory = join(directory, "alias");
  try {
    await mkdir(realDirectory, { mode: 0o700 });
    await writeFile(join(realDirectory, "model.json"), "{}", { encoding: "utf8", mode: 0o600 });
    await symlink(realDirectory, aliasDirectory);
    await assert.rejects(
      readBoundedUtf8File(join(aliasDirectory, "model.json"), 8 * 1024, "ancestor-alias model"),
      /non-symbolic-link ancestor directories/u
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test(
  "bounded cleaning-history reads use immutable committed objects natively on macOS and Windows",
  { skip: process.platform !== "darwin" && process.platform !== "win32" },
  async () => {
    const committedPath = fileURLToPath(new URL("../fixtures/cleaning-history-capabilities.json", import.meta.url));
    const expected = await readFile(committedPath, "utf8");
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-platform-boundary-"));
    const path = join(directory, "model.json");
    let identityChecks = 0;
    let completedReads = 0;
    try {
      await writeFile(path, "{}", { encoding: "utf8", mode: 0o600 });
      assert.equal(
        await readBoundedUtf8File(committedPath, 8 * 1024, `${process.platform} committed model`, {
          afterPortableIdentity: () => {
            identityChecks += 1;
          },
          afterPortableRead: () => {
            completedReads += 1;
          }
        }),
        expected
      );
      assert.equal(identityChecks, 1);
      assert.equal(completedReads, 1);
      await assert.rejects(
        readBoundedUtf8File(path, 8 * 1024, `${process.platform} model`),
        /outside the bounded repository input inventory/u
      );
      await assert.rejects(
        readBoundedUtf8File(committedPath, 1, `${process.platform} oversized model`),
        /exceeds the 1-byte validation limit/u
      );
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

test(
  "bounded cleaning-history reads close a just-opened ancestor when identity changes before recording",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-ancestor-open-race-"));
    const active = join(directory, "active");
    const retired = join(directory, "retired");
    const path = join(active, "model.json");
    try {
      await mkdir(active, { mode: 0o700 });
      await writeFile(path, "{}", { encoding: "utf8", mode: 0o600 });
      const descriptorCount = (await readdir("/proc/self/fd")).length;
      await assert.rejects(
        readBoundedUtf8File(path, 8 * 1024, "ancestor-open-race model", {
          afterAncestorOpenBeforeIdentity: async ({ directory: openedDirectory }) => {
            if (openedDirectory !== active) return;
            await rename(active, retired);
            await mkdir(active, { mode: 0o700 });
            await writeFile(path, '{"source":"replacement"}', { encoding: "utf8", mode: 0o600 });
          }
        }),
        /ancestor changed identity/u
      );
      assert.equal((await readdir("/proc/self/fd")).length, descriptorCount);
      await rm(active, { recursive: true });
      await rename(retired, active);
      assert.equal(await readBoundedUtf8File(path, 8 * 1024, "restored open-race model"), "{}");
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

test(
  "bounded cleaning-history reads reject a same-size torn rewrite and preserve stable content",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-torn-read-"));
    const path = join(directory, "model.json");
    const original = `${"a".repeat(128 * 1024 - 2)}{}`;
    try {
      await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
      let replaced = false;
      await assert.rejects(
        readBoundedUtf8File(path, 256 * 1024, "same-size torn model", {
          afterReadChunk: async () => {
            if (replaced) return;
            replaced = true;
            const writer = await openFile(path, "r+");
            try {
              await writer.write(Buffer.from("b"), 0, 1, 0);
              await writer.sync();
            } finally {
              await writer.close();
            }
          }
        }),
        /changed identity or contents/u
      );
      await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
      assert.equal(await readBoundedUtf8File(path, 256 * 1024, "stable model"), original);
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

test(
  "bounded cleaning-history reads reject an ancestor replace-read and remain usable after restore",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-ancestor-swap-"));
    const active = join(directory, "active");
    const retired = join(directory, "retired");
    const path = join(active, "model.json");
    try {
      await mkdir(active, { mode: 0o700 });
      await writeFile(path, '{"source":"original"}', { encoding: "utf8", mode: 0o600 });
      await assert.rejects(
        readBoundedUtf8File(path, 8 * 1024, "ancestor-swap model", {
          afterInitialLeafIdentity: async () => {
            await rename(active, retired);
            await mkdir(active, { mode: 0o700 });
            await writeFile(path, '{"source":"replacement"}', { encoding: "utf8", mode: 0o600 });
          }
        }),
        /ancestor changed identity|changed identity or contents/u
      );
      await rm(active, { recursive: true });
      await rename(retired, active);
      assert.equal(await readBoundedUtf8File(path, 8 * 1024, "restored ancestor model"), '{"source":"original"}');
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

test(
  "bounded cleaning-history reads reject a regular-to-FIFO swap without blocking or leaking the descriptor",
  { skip: process.platform !== "linux" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-fifo-swap-"));
    const path = join(directory, "model.json");
    const retired = join(directory, "retired.json");
    try {
      await writeFile(path, "{}", { encoding: "utf8", mode: 0o600 });
      const started = Date.now();
      await assert.rejects(
        readBoundedUtf8File(path, 8 * 1024, "FIFO-swap model", {
          afterInitialLeafIdentity: async () => {
            await rename(path, retired);
            const result = spawnSync("mkfifo", [path], { encoding: "utf8" });
            assert.equal(result.status, 0, result.stderr);
          }
        }),
        /remain one regular file|changed identity/u
      );
      assert.ok(Date.now() - started < 2_000, "the no-follow FIFO rejection must not wait for a writer");
      await rm(path);
      await rename(retired, path);
      assert.equal(await readBoundedUtf8File(path, 8 * 1024, "restored model"), "{}");
    } finally {
      await rm(directory, { recursive: true });
    }
  }
);

test(
  "bounded cleaning-history reads reject a FIFO before allocating a read buffer",
  { skip: process.platform !== "linux" },
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
