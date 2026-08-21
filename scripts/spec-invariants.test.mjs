import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { checkWebviewStyles, WEBVIEW_STYLE_IMPORTS, WEBVIEW_STYLE_LIMITS } from "./check-webview-styles.mjs";
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
