import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { link, mkdtemp, mkdir, open, opendir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkWebviewStyles, WEBVIEW_STYLE_IMPORTS, WEBVIEW_STYLE_LIMITS } from "./check-webview-styles.mjs";
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

async function webviewStyleFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ow-webview-styles-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const webviewRoot = resolve(root, "src/webviews");
  const styleRoot = resolve(webviewRoot, "styles");
  await mkdir(styleRoot, { recursive: true });
  await writeFile(
    resolve(webviewRoot, "styles.css"),
    `${WEBVIEW_STYLE_IMPORTS.map((file) => `@import "./styles/${file}";`).join("\n")}\n`,
    "utf8"
  );
  await Promise.all(
    WEBVIEW_STYLE_IMPORTS.map((file) =>
      writeFile(resolve(styleRoot, file), file === "foundations.css" ? ".used { display: block; }\n" : "", "utf8")
    )
  );
  await writeFile(resolve(webviewRoot, "App.tsx"), 'export const app = <div className="used" />;\n', "utf8");
  await writeFile(resolve(webviewRoot, "main.tsx"), 'import "./App";\nimport "./styles.css";\n', "utf8");
  return { root, styleRoot, webviewRoot };
}

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
    "Modification of the final operation is the sole form supported.",
    "The prior transformation is read-only and cannot be revised.",
    "Amending a preceding plan entry is impossible.",
    "Rollback is available for a specifically chosen plan entry.",
    "Every operation can be restored independently.",
    "A selected older operation is reversible through Undo.",
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
    "Committed steps may be re&#x2d;arranged."
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

test("a code example cannot hide a separate rendered inline contradiction", () => {
  const model = cleaningHistoryModel();
  const documents = cleaningHistoryDocuments(model);
  documents["README.md"] = documents["README.md"].replace(
    "<!-- cleaning-history-capabilities:readme-transformations:end -->",
    [
      "<!-- cleaning-history-capabilities:readme-transformations:end -->",
      "Use `Committed steps may be reordered` only as a rejected-input example.",
      "Only the `latest` committed step can be edited."
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
      "Editing operations is restricted to the newest one.",
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

test("bounded cleaning-history reads reject hostile size before decoding the complete file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-cleaning-history-bound-"));
  const path = join(directory, "oversized.json");
  const handle = await open(path, "w");
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

test("bounded cleaning-history reads reject a symlinked ancestor", async () => {
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
  "bounded cleaning-history reads reject a regular-to-FIFO swap without blocking or leaking the descriptor",
  { skip: process.platform === "win32" },
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

test("the repository webview stylesheet entry has bounded owners and no dead selector classes", async () => {
  const receipt = await checkWebviewStyles();
  assert.equal(receipt.entry, "src/webviews/styles.css");
  assert.equal(receipt.ownedStylesheets, 11);
  assert.ok(receipt.selectorClasses > 0);
  assert.ok(receipt.sourceFiles > 0);
});

test("the webview style check rejects an unreferenced selector mutation", async (t) => {
  const { root, styleRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "application.css"), ".orphan { display: block; }\n", "utf8");
  await assert.rejects(checkWebviewStyles(root), /orphan \(application\.css\)/u);
});

test("the webview style check rejects import reordering and dead-selector resurrection", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  const reversedImports = [...WEBVIEW_STYLE_IMPORTS]
    .reverse()
    .map((file) => `@import "./styles/${file}";`)
    .join("\n");
  await writeFile(resolve(webviewRoot, "styles.css"), `${reversedImports}\n`, "utf8");
  await assert.rejects(checkWebviewStyles(root), /canonical owned-style imports in order/u);

  const canonicalImports = WEBVIEW_STYLE_IMPORTS.map((file) => `@import "./styles/${file}";`).join("\n");
  await writeFile(resolve(webviewRoot, "styles.css"), `${canonicalImports}\n`, "utf8");
  await writeFile(resolve(styleRoot, "grid-insights.css"), ".miniBar { display: block; }\n", "utf8");
  await writeFile(resolve(webviewRoot, "Grid.tsx"), 'export const gridClassName = "miniBar";\n', "utf8");
  await assert.rejects(checkWebviewStyles(root), /Removed selector\(s\) must stay absent: miniBar/u);
});

test("the webview style check enforces the remaining global-style ratchet", async (t) => {
  const { root, styleRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "foundations.css"), `${Array(101).fill(":root {}").join("\n")}\n`, "utf8");
  await assert.rejects(checkWebviewStyles(root), /foundations\.css has 101 lines, above its 100-line ownership limit/u);
});

test("the webview style parser understands CSS grammar and only TypeScript class sinks prove ownership", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  const imports = WEBVIEW_STYLE_IMPORTS.map((file, index) => {
    const target = file === "foundations.css" ? "./styles/foundations.\\63ss" : `./styles/${file}`;
    return `${index % 2 === 0 ? "@\\69mport" : "@IMPORT"} /* owner */ "${target}";`;
  }).join("\n");
  await writeFile(resolve(webviewRoot, "styles.css"), `/* canonical owners */\n${imports}\n`, "utf8");
  await writeFile(
    resolve(styleRoot, "foundations.css"),
    [
      "/* .commentOnly must not become a selector. */",
      "@MEDIA screen {",
      '  .\\75 sed, .café, [data-proof=".attributeOnly"] {',
      '    content: ".stringOnly";',
      '    background-image: url("https://example.invalid/.urlOnly");',
      '    --custom-proof: ".customPropertyOnly";',
      "  }",
      "  @supports selector(.atRuleOnly) {",
      '    :root { --nested-proof: ".nestedDeclarationOnly"; }',
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    [
      'const unrelated = "commentOnly attributeOnly stringOnly urlOnly customPropertyOnly atRuleOnly nestedDeclarationOnly";',
      'export const app = <div className="used café" data-unrelated={unrelated} />;',
      ""
    ].join("\n"),
    "utf8"
  );

  const receipt = await checkWebviewStyles(root);
  assert.equal(receipt.selectorClasses, 2);
});

test("the webview style parser rejects unrelated TypeScript strings as selector evidence", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "application.css"), ".orphan { display: block; }\n", "utf8");
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    [
      'export const unrelated = "orphan";',
      'export const url = "https://example.invalid/.orphan";',
      'export const commaJoined = <div className={["orphan", "other"].join()} />;',
      'export const app = <div title="orphan" data-proof="orphan" className="used" />;',
      ""
    ].join("\n"),
    "utf8"
  );

  await assert.rejects(checkWebviewStyles(root), /orphan \(application\.css\)/u);
});

test("selector liveness is limited to the workbench main.tsx bundle closure", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "application.css"), ".separateBundleOnly { display: block; }\n", "utf8");
  await writeFile(
    resolve(webviewRoot, "SeparateBundle.tsx"),
    'export type SeparateProps = {};\nexport const separate = <div className="separateBundleOnly" />;\n',
    "utf8"
  );
  await writeFile(
    resolve(webviewRoot, "TypeBridge.ts"),
    'export { type SeparateProps } from "./SeparateBundle";\n',
    "utf8"
  );
  await writeFile(
    resolve(webviewRoot, "main.tsx"),
    'import "./App";\nimport "./TypeBridge";\nimport "./styles.css";\n',
    "utf8"
  );

  await assert.rejects(checkWebviewStyles(root), /separateBundleOnly \(application\.css\)/u);

  await writeFile(
    resolve(webviewRoot, "main.tsx"),
    'import "./App";\nimport "./SeparateBundle";\nimport "./styles.css";\n',
    "utf8"
  );
  await assert.doesNotReject(checkWebviewStyles(root));
});

test("only rendering sinks, additive DOM class calls, and new replace operands prove liveness", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    [
      "const fake = {",
      '  className: "",',
      "  classList: { add() {}, remove() {}, replace() {} },",
      "  setAttribute() {}",
      "};",
      'fake.className = "fakeAssignment";',
      'fake.classList.add("fakeSink");',
      'fake.setAttribute("class", "fakeAttribute");',
      'const element = document.createElement("div");',
      'element.classList.remove("removedOnly");',
      'element.classList.replace("oldReplace", "newReplace");',
      "const DiscardingComponent = (_props: { className: string }) => <span />;",
      "export const app = (",
      "  <>",
      '    <DiscardingComponent className="customComponentSink" />',
      '    <div className="used" />',
      "  </>",
      ");",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(resolve(styleRoot, "application.css"), ".newReplace { display: block; }\n", "utf8");
  await assert.doesNotReject(checkWebviewStyles(root));

  await writeFile(
    resolve(styleRoot, "application.css"),
    [
      ".newReplace,",
      ".fakeAssignment,",
      ".fakeSink,",
      ".fakeAttribute,",
      ".removedOnly,",
      ".oldReplace,",
      ".customComponentSink { display: block; }",
      ""
    ].join("\n"),
    "utf8"
  );
  await assert.rejects(checkWebviewStyles(root), (error) => {
    for (const className of [
      "customComponentSink",
      "fakeAssignment",
      "fakeAttribute",
      "fakeSink",
      "oldReplace",
      "removedOnly"
    ]) {
      assert.match(error.message, new RegExp(`${className} \\(application\\.css\\)`, "u"));
    }
    assert.doesNotMatch(error.message, /newReplace/u);
    return true;
  });
});

test("a module-local document lookalike cannot prove selector liveness", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "application.css"), ".shadowedDocumentSink { display: block; }\n", "utf8");
  await writeFile(
    resolve(webviewRoot, "ShadowedDocument.tsx"),
    [
      "const fake = { classList: { add() {} } };",
      "const document = { createElement: () => fake };",
      'document.createElement("div").classList.add("shadowedDocumentSink");',
      "export const shadowed = true;",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    resolve(webviewRoot, "main.tsx"),
    'import "./App";\nimport "./ShadowedDocument";\nimport "./styles.css";\n',
    "utf8"
  );

  await assert.rejects(checkWebviewStyles(root), /shadowedDocumentSink \(application\.css\)/u);
});

test("DOM class liveness follows lexical bindings, reassignment, and forced toggle removal", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    [
      "const fake = { classList: { add() {}, toggle() {} } };",
      'const element = document.createElement("div");',
      'element.classList.add("outerLive");',
      "{",
      "  const element = fake;",
      '  element.classList.add("shadowedSink");',
      "}",
      'let reassigned = document.createElement("div");',
      "reassigned = fake;",
      'reassigned.classList.add("reassignedSink");',
      "function useShadowedDocument() {",
      "  const document = { createElement: () => fake };",
      '  document.createElement().classList.add("shadowedDocumentSink");',
      "}",
      'document.createElement("div").classList.add("globalLive");',
      'document.createElement("div").classList.toggle("forcedFalse", false);',
      'document.createElement("div").classList.toggle("forcedTrue", true);',
      "void useShadowedDocument;",
      'export const app = <div className="used" />;',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    resolve(styleRoot, "application.css"),
    ".outerLive, .globalLive, .forcedTrue { display: block; }\n",
    "utf8"
  );
  await assert.doesNotReject(checkWebviewStyles(root));

  await writeFile(
    resolve(styleRoot, "application.css"),
    [
      ".outerLive,",
      ".globalLive,",
      ".forcedTrue,",
      ".shadowedSink,",
      ".reassignedSink,",
      ".shadowedDocumentSink,",
      ".forcedFalse { display: block; }",
      ""
    ].join("\n"),
    "utf8"
  );
  await assert.rejects(checkWebviewStyles(root), (error) => {
    for (const className of ["forcedFalse", "reassignedSink", "shadowedDocumentSink", "shadowedSink"]) {
      assert.match(error.message, new RegExp(`${className} \\(application\\.css\\)`, "u"));
    }
    for (const className of ["forcedTrue", "globalLive", "outerLive"]) {
      assert.doesNotMatch(error.message, new RegExp(`${className} \\(application\\.css\\)`, "u"));
    }
    return true;
  });
});

test("a named class expression keeps its name private from a live global document sibling", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    [
      "const Holder = class document {",
      "  static probe() {",
      '    document.createElement("div").classList.add("classLocalDocumentSink");',
      "  }",
      "};",
      'document.createElement("div").classList.add("globalDocumentLive");',
      "void Holder;",
      'export const app = <div className="used" />;',
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(resolve(styleRoot, "application.css"), ".globalDocumentLive { display: block; }\n", "utf8");
  await assert.doesNotReject(checkWebviewStyles(root));

  await writeFile(
    resolve(styleRoot, "application.css"),
    ".globalDocumentLive, .classLocalDocumentSink { display: block; }\n",
    "utf8"
  );
  await assert.rejects(checkWebviewStyles(root), (error) => {
    assert.match(error.message, /classLocalDocumentSink \(application\.css\)/u);
    assert.doesNotMatch(error.message, /globalDocumentLive \(application\.css\)/u);
    return true;
  });
});

test("the TypeScript liveness walk handles deeply nested valid TSX iteratively", async (t) => {
  const { root, webviewRoot } = await webviewStyleFixture(t);
  const depth = 300;
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    `export const app = ${"<div>".repeat(depth)}<span className="used" />${"</div>".repeat(depth)};\n`,
    "utf8"
  );

  await assert.doesNotReject(checkWebviewStyles(root));
});

test("parser stack exhaustion becomes the bounded TypeScript AST-depth diagnostic", async (t) => {
  const { root, webviewRoot } = await webviewStyleFixture(t);
  const depth = 5_000;
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    `export const app = ${"<div>".repeat(depth)}<span className="used" />${"</div>".repeat(depth)};\n`,
    "utf8"
  );

  await assert.rejects(
    checkWebviewStyles(root),
    new RegExp(`App\\.tsx exceeds the ${WEBVIEW_STYLE_LIMITS.typescriptAstDepth}-level TypeScript AST limit\\.`, "u")
  );
});

test("the CSS parser inventories @scope and native nested selectors without declaration false positives", async (t) => {
  const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t);
  await writeFile(
    resolve(styleRoot, "foundations.css"),
    [
      "@scope (.scopeRoot) to (.scopeLimit) {",
      "  .parent {",
      '    --not-a-selector: ".customPropertyOnly";',
      '    background: url("https://example.invalid/.urlOnly");',
      "    &.ampersandNested { color: inherit; }",
      "    .nativeNested { color: inherit; }",
      "    @media (min-width: 1px) {",
      "      .mediaNested { color: inherit; }",
      "    }",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    resolve(webviewRoot, "App.tsx"),
    'export const app = <div className="scopeRoot scopeLimit parent ampersandNested nativeNested mediaNested" />;\n',
    "utf8"
  );

  const receipt = await checkWebviewStyles(root);
  assert.equal(receipt.selectorClasses, 6);

  await writeFile(
    resolve(styleRoot, "foundations.css"),
    ".parent { button .nativeNested { color: inherit; } }\n",
    "utf8"
  );
  await assert.rejects(checkWebviewStyles(root), /nested type selectors must use an explicit & prefix/u);
});

test("the CSS parser rejects group nesting beyond its explicit recursion cap", async (t) => {
  const { root, styleRoot } = await webviewStyleFixture(t);
  const depth = WEBVIEW_STYLE_LIMITS.nestingDepth + 1;
  const source = `${"@media all {".repeat(depth)}.used { display: block; }${"}".repeat(depth)}\n`;
  await writeFile(resolve(styleRoot, "application.css"), source, "utf8");
  await assert.rejects(checkWebviewStyles(root), /exceeds the 32-level CSS nesting limit/u);
});

test("the webview style parser recognizes escaped and case-insensitive forbidden grammar", async (t) => {
  const { root, styleRoot } = await webviewStyleFixture(t);
  await writeFile(resolve(styleRoot, "application.css"), '@\\69MPORT "./unexpected.css";\n', "utf8");
  await assert.rejects(checkWebviewStyles(root), /must not contain nested imports/u);

  await writeFile(resolve(styleRoot, "application.css"), ".\\6diniBar { display: block; }\n", "utf8");
  await assert.rejects(checkWebviewStyles(root), /Removed selector\(s\) must stay absent: miniBar/u);
});

test("the webview style check rejects symbolic leaves and descriptor-visible leaf replacement", async (t) => {
  const symbolicFixture = await webviewStyleFixture(t);
  const entryPath = resolve(symbolicFixture.webviewRoot, "styles.css");
  await unlink(entryPath);
  await symlink("styles/foundations.css", entryPath);
  await assert.rejects(checkWebviewStyles(symbolicFixture.root), /no-follow regular file/u);

  const racedFixture = await webviewStyleFixture(t);
  const target = resolve(racedFixture.styleRoot, "application.css");
  const original = `${target}.original`;
  const replacement = `${target}.replacement`;
  await writeFile(replacement, ".used { display: block; }\n", "utf8");
  let replaced = false;
  await assert.rejects(
    checkWebviewStyles(racedFixture.root, {
      filesystem: {
        async open(path, flags) {
          const handle = await open(path, flags);
          if (path === target && !replaced) {
            replaced = true;
            await rename(target, original);
            await rename(replacement, target);
          }
          return handle;
        }
      }
    }),
    /application\.css changed while its (?:no-follow descriptor was opened|descriptor-bound snapshot was read)/u
  );
  assert.equal(replaced, true);
});

test("the webview style check rejects a replaced ancestor after opening its no-follow descriptor", async (t) => {
  const { root, styleRoot } = await webviewStyleFixture(t);
  const original = `${styleRoot}.original`;
  let replaced = false;
  await assert.rejects(
    checkWebviewStyles(root, {
      filesystem: {
        async open(path, flags) {
          const handle = await open(path, flags);
          if (path === styleRoot && !replaced) {
            replaced = true;
            await rename(styleRoot, original);
            await mkdir(styleRoot);
          }
          return handle;
        }
      }
    }),
    /src\/webviews\/styles ancestor changed while its (?:no-follow descriptor was opened|descriptor-bound operation ran)/u
  );
  assert.equal(replaced, true);
});

test("the webview style inventory is streamed, bounded, replacement-safe, and single-link", async (t) => {
  await t.test("wide directories count non-CSS entries before retention", async (t_) => {
    const { root, styleRoot } = await webviewStyleFixture(t_);
    const additional = WEBVIEW_STYLE_LIMITS.directoryEntries - WEBVIEW_STYLE_IMPORTS.length + 1;
    await Promise.all(
      Array.from({ length: additional }, (_, index) =>
        writeFile(resolve(styleRoot, `unowned-${index}.txt`), "", "utf8")
      )
    );
    await assert.rejects(checkWebviewStyles(root), /256-entry directory inventory limit/u);
  });

  await t.test("directory replacement during its streamed inventory fails closed", async (t_) => {
    const { root, styleRoot } = await webviewStyleFixture(t_);
    const original = `${styleRoot}.original`;
    let replaced = false;
    await assert.rejects(
      checkWebviewStyles(root, {
        filesystem: {
          async opendir(path, options) {
            const directory = await opendir(path, options);
            if (path === styleRoot && !replaced) {
              replaced = true;
              await rename(styleRoot, original);
              await mkdir(styleRoot);
            }
            return directory;
          }
        }
      }),
      /src\/webviews\/styles ancestor changed while its descriptor-bound operation ran/u
    );
    assert.equal(replaced, true);
  });

  await t.test("hard-linked owned inputs fail the single-link check", async (t_) => {
    const { root, styleRoot, webviewRoot } = await webviewStyleFixture(t_);
    await link(resolve(styleRoot, "foundations.css"), resolve(webviewRoot, "foundations.alias"));
    await assert.rejects(checkWebviewStyles(root), /foundations\.css must be a single-link no-follow regular file/u);
  });
});

test("the webview style check enforces selector count and length budgets", async (t) => {
  await t.test("class selector occurrences", async (t_) => {
    const { root, styleRoot } = await webviewStyleFixture(t_);
    const selectors = Array.from(
      { length: WEBVIEW_STYLE_LIMITS.selectorOccurrences + 1 },
      (_, index) => `.bounded${index}{}`
    ).join("");
    await writeFile(resolve(styleRoot, "application.css"), selectors, "utf8");
    await assert.rejects(checkWebviewStyles(root), /class-selector budget/u);
  });

  await t.test("class name length", async (t_) => {
    const { root, styleRoot } = await webviewStyleFixture(t_);
    const className = "x".repeat(WEBVIEW_STYLE_LIMITS.classNameCodePoints + 1);
    await writeFile(resolve(styleRoot, "application.css"), `.${className} { display: block; }\n`, "utf8");
    await assert.rejects(checkWebviewStyles(root), /class selector above the 256-code-point limit/u);
  });

  await t.test("selector prelude length", async (t_) => {
    const { root, styleRoot } = await webviewStyleFixture(t_);
    const selector = Array.from({ length: 2_000 }, () => ".used").join(",");
    assert.ok(selector.length > WEBVIEW_STYLE_LIMITS.selectorCodeUnits);
    await writeFile(resolve(styleRoot, "application.css"), `${selector} { display: block; }\n`, "utf8");
    await assert.rejects(checkWebviewStyles(root), /selector prelude above the 8192-code-unit limit/u);
  });
});

test("the webview style check enforces one explicit total-work budget", async (t) => {
  const { root, webviewRoot } = await webviewStyleFixture(t);
  const largeComment = `/*${"x".repeat(450_000)}*/\n`;
  await Promise.all(
    Array.from({ length: 5 }, (_, index) => writeFile(resolve(webviewRoot, `Large${index}.ts`), largeComment, "utf8"))
  );
  await writeFile(
    resolve(webviewRoot, "main.tsx"),
    `${Array.from({ length: 5 }, (_, index) => `import "./Large${index}";`).join("\n")}\nimport "./App";\n`,
    "utf8"
  );
  await assert.rejects(checkWebviewStyles(root), /total-work budget/u);
});
