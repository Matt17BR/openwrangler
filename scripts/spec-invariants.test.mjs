import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkWebviewStyles, WEBVIEW_STYLE_IMPORTS } from "./check-webview-styles.mjs";
import {
  assertGeneratedFilesCurrent,
  buildCrosswalk,
  checkGeneratedFiles,
  extractInvariantSection,
  parseInvariantEntries,
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
  await writeFile(resolve(webviewRoot, "App.tsx"), 'export const appClassName = "used";\n', "utf8");
  return { root, styleRoot, webviewRoot };
}

function fixtureSection(overrides = new Map()) {
  const entries = Array.from({ length: 58 }, (_, index) => {
    const id = index + 1;
    return overrides.get(id) ?? `${id}. Invariant ${id} text.`;
  });
  return `## Non-negotiable invariants\n\n${entries.join("\n")}\n`;
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
  assert.equal(receipt.ownedStylesheets, 10);
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
