import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { ZipFile } from "yazl";
import { COMPARISON_TEST_SHA, createReleaseComparisonReport } from "./data-wrangler-comparison-test-fixtures.mjs";
import {
  inspectVsixArchive,
  MAX_VSIX_ENTRY_BYTES,
  VENDORED_JS_YAML_BYTES,
  VENDORED_JS_YAML_SHA256
} from "./vsix-archive.mjs";
import { VENDORED_JS_YAML_ENTRY } from "./vsix-contents.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import {
  inspectPreviewReleaseMetadata,
  inspectReleaseMetadata,
  inspectWorkflowReleaseMetadata,
  isHistoricalTagRecoveryVersion,
  releaseSourcePolicyForVersion
} from "./release-metadata.mjs";
import { inspectPreviewReleaseWorkflow as inspectReleaseWorkflow } from "./preview-release-workflow.mjs";
import {
  inspectPerformanceEvidenceReadme,
  inspectPreviewReadme,
  inspectStablePublicCopy,
  inspectStableReadme,
  PREVIEW_README_RELEASE_SECTION
} from "./release-documents.mjs";
import {
  inspectPerformanceEvidenceCandidateReadiness,
  inspectPerformanceEvidenceSourceReadiness,
  inspectPerformanceSummary,
  inspectPreviewRParitySource,
  inspectReleaseDocumentationSource,
  inspectStableReleaseReadiness,
  inspectStableSourceReadiness,
  PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
  PERFORMANCE_EVIDENCE_PARTIAL_ROWS,
  PERFORMANCE_EVIDENCE_VERSION,
  PRIMARY_PARITY_SCOPE,
  R_PREVIEW_PARITY_SCOPE,
  R_STABLE_PARITY_SCOPE,
  readOwnedVsixSnapshot,
  readReleaseSourceSnapshot,
  readStableVsixPayload,
  revalidateStableReleaseArtifacts,
  STABLE_README_RELEASE_SECTION,
  writeStableReleaseArtifacts
} from "./release-readiness.mjs";

const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const repositoryRoot = resolve(import.meta.dirname, "..");
const vendoredJsYaml = readFileSync(resolve(repositoryRoot, "node_modules/js-yaml/dist/js-yaml.cjs.js"));
const rRuntimeEntries = Object.freeze([
  "extension/r/openwrangler_runtime/frame_contract.R",
  "extension/r/openwrangler_runtime/interactive_agent.R",
  "extension/r/openwrangler_runtime/kernel_agent.R",
  "extension/r/openwrangler_runtime/process_agent.R"
]);
const stablePackage = {
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR",
  version: "1.0.0",
  preview: false
};

function manifest({ id = "openwrangler", publisher = "Matt17BR", version = "1.0.0", properties = "" } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="${namespace}">
  <Metadata>
    <Identity Id="${id}" Publisher="${publisher}" Version="${version}" />
    <Properties>${properties}</Properties>
  </Metadata>
</PackageManifest>`;
}

function parity(
  status = "Done",
  scope = PRIMARY_PARITY_SCOPE,
  evidence = "Exact package acceptance; test:scripts/release-readiness.test.mjs"
) {
  const rows = scope
    .map(([surface, pandas, polars]) => {
      const rowStatus = typeof status === "function" ? status(surface) : status;
      return `| ${surface} | ${pandas} | ${polars} | ${rowStatus} | ${evidence} |`;
    })
    .join("\n");
  return `# Feature parity matrix

| Surface | Pandas | Polars | Status | Required evidence |
| --- | ---: | ---: | --- | --- |
${rows}

## DuckDB file-backed preview matrix

| Surface | Status |
| --- | --- |
| Grid | Partial |
`;
}

function previewRParity({ currentChecks, scope = R_PREVIEW_PARITY_SCOPE, status } = {}) {
  const surfaceMarkdown = new Map([
    ["Base data.frame, tibble, and data.table", "Base `data.frame`, tibble, and `data.table`"],
    ["Cursor-owned .Rmd and .qmd R/Python chunk", "Cursor-owned `.Rmd` and `.qmd` R/Python chunk"],
    ["Owned .R source process", "Owned `.R` source process"],
    ["Owned .Rmd and .qmd cell process", "Owned `.Rmd` and `.qmd` cell process"],
    ["Insert generated R into its source .R file", "Insert generated R into its source `.R` file"],
    ["Insert generated R into .Rmd and .qmd", "Insert generated R into `.Rmd` and `.qmd`"]
  ]);
  const rows = scope
    .map(([surface, availability, expectedStatus, expectedChecks]) => {
      const rowStatus = typeof status === "function" ? status(surface) : (status ?? expectedStatus);
      const rowChecks =
        typeof currentChecks === "function"
          ? currentChecks(surface)
          : (currentChecks ?? expectedChecks ?? "Current automated preview evidence remains truthful.");
      return `| ${surfaceMarkdown.get(surface) ?? surface} | ${availability} | ${rowStatus} | ${rowChecks} | Preview release |`;
    })
    .join("\n");
  return `## Native R preview

| Surface | Availability | Status | Current checks | Release check |
| --- | --- | --- | --- | --- |
${rows}
`;
}

function stableRParity({ evidence, scope = R_STABLE_PARITY_SCOPE, status = "Done" } = {}) {
  const rows = scope
    .map((row) => {
      const rowStatus = typeof status === "function" ? status(row.surface) : status;
      const rowEvidence =
        typeof evidence === "function"
          ? evidence(row)
          : (evidence ?? `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}`);
      return `| ${row.surface} | ${row.availability} | ${rowStatus} | ${rowEvidence} | Stable release |`;
    })
    .join("\n");
  return `## Native R support

| Surface | Availability | Status | Required evidence | Release gate |
| --- | --- | --- | --- | --- |
${rows}
`;
}

function stableRTrackedEvidencePaths() {
  return new Set(
    R_STABLE_PARITY_SCOPE.flatMap((row) => row.evidence.map((reference) => reference.slice(reference.indexOf(":") + 1)))
  );
}

const expectedStableRScope = [
  ["Native R frame paging and typed cells", "All supported R sessions", "r/tests/frame_contract.R"],
  ["Native R compound viewing filters", "All supported R sessions", "r/tests/frame_contract.R"],
  ["Native R value search and selections", "All supported R sessions", "r/tests/frame_contract.R"],
  ["Native R ordered viewing sorts", "All supported R sessions", "r/tests/frame_contract.R"],
  ["Native R column and dataset profiles", "All supported R sessions", "r/tests/frame_contract.R"],
  ["Base data.frame, tibble, and data.table", "All supported R sessions", "r/tests/frame_contract.R"],
  [
    "Ordinary collapse::qDF(), collapse::qTBL(), and collapse::qDT() frames",
    "All supported R sessions",
    "r/tests/frame_contract.R"
  ],
  ["Exact IRkernel session transport", "Linux, macOS, and Windows", "src/test/rKernelTransport.cross.test.ts"],
  ["Exact active R-terminal transport", "Linux", "src/test/rInteractiveSessionTransport.cross.test.ts"],
  ["Cursor .Rmd document command and .qmd R/Python chunk actions", "Linux", "src/test/rDocumentCommands.unit.test.ts"],
  ["Owned .R source process", "Linux and macOS", "src/test/rProcessTransport.cross.test.ts"],
  ["Owned .Rmd and .qmd cell process", "Linux and macOS", "src/test/literateDocumentChunks.unit.test.ts"],
  ["Notebook workbench", "Linux, macOS, and Windows", "src/test/rKernelBridge.unit.test.ts"],
  [
    "Complete R cleaning catalog and generated code",
    "All 28 catalog operations",
    "r/tests/complete_catalog_contract.R"
  ],
  ["Copy or save generated R", "All 28 catalog operations", "src/test/rCompleteCatalogCodeExport.unit.test.ts"],
  [
    "Insert generated R into its IRkernel notebook",
    "Linux, macOS, and Windows",
    "src/test/notebookInsertion.unit.test.ts"
  ],
  ["Insert generated R into its source .R file", "Linux and macOS", "src/test/rDocumentInsertion.unit.test.ts"],
  ["Insert generated R into .Rmd and .qmd", "Linux and macOS", "src/test/rDocumentInsertion.unit.test.ts"],
  ["Cleaned-data export", "CSV and Parquet", "r/tests/frame_contract.R"],
  ["Active R-terminal cleaned-data export", "Linux", "src/test/rInteractiveExport.unit.test.ts"],
  ["Quarto and R Markdown lexical R-cell run", "Linux and macOS", "src/test/literateDocumentChunks.unit.test.ts"],
  ["Native R performance record", "Release candidate", "scripts/r-performance-report.test.mjs"],
  ["First-class editor candidate acceptance", "VS Code and Cursor", "scripts/candidate-acceptance-workflow.test.mjs"]
].map(([surface, availability, rowTest]) => ({
  availability,
  evidence: [
    `test:${rowTest}`,
    "test:src/test/extensionHost/index.ts",
    "workflow:.github/workflows/candidate-acceptance.yml",
    "record:docs/testing.md"
  ],
  surface
}));

const stableV2Version = "2.0.0";
const stableV2ReportPath = `docs/performance/data-wrangler-${stableV2Version}/review.md`;
const stableV2ReportDataPath = `docs/performance/data-wrangler-${stableV2Version}/report.json`;
const stableV2Readme = `# Open Wrangler

${STABLE_README_RELEASE_SECTION}

## Performance

[dated report](https://github.com/Matt17BR/openwrangler/blob/main/${stableV2ReportPath})
`;

function stableV2Ready(overrides = {}) {
  const packageJson = { ...stablePackage, version: stableV2Version };
  return ready({
    releaseTag: `v${stableV2Version}`,
    sourcePackageJson: JSON.stringify(packageJson),
    pythonVersionFile: `__version__ = "${stableV2Version}"\n`,
    featureParity: `${parity()}\n${stableRParity()}`,
    changelog: `# Changelog

## [${stableV2Version}] - 2026-08-13

### Added

- Published the reviewed stable Native R scope.
`,
    readme: stableV2Readme,
    packagedPackageJson: JSON.stringify(packageJson),
    packagedPythonVersionFile: `__version__ = "${stableV2Version}"\n`,
    packagedReadme: stableV2Readme,
    trackedEvidencePaths: new Set([
      ...ready().trackedEvidencePaths,
      ...stableRTrackedEvidencePaths(),
      stableV2ReportPath,
      stableV2ReportDataPath
    ]),
    performanceReportFiles: new Map([
      [
        stableV2ReportDataPath,
        JSON.stringify(createReleaseComparisonReport({ version: stableV2Version, sha256: COMPARISON_TEST_SHA }))
      ]
    ]),
    candidateSha256: COMPARISON_TEST_SHA,
    vsixManifest: manifest({ version: stableV2Version }),
    ...overrides
  });
}

function ready(overrides = {}) {
  return {
    releaseTag: "v1.0.0",
    sourcePackageJson: JSON.stringify(stablePackage),
    pythonVersionFile: '__version__ = "1.0.0"\n',
    featureParity: parity(),
    changelog: "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Added\n\n- Published the verified stable package.\n",
    readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    packagedPackageJson: JSON.stringify(stablePackage),
    packagedPythonVersionFile: '__version__ = "1.0.0"\n',
    packagedReadme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
    trackedEvidencePaths: new Set([
      ".github/workflows/release.yml",
      "docs/testing.md",
      "scripts/release-readiness.test.mjs"
    ]),
    vsixManifest: manifest(),
    ...overrides
  };
}

function performanceEvidenceReady(overrides = {}) {
  const performanceRows = new Set(PERFORMANCE_EVIDENCE_PARTIAL_ROWS);
  return ready({
    featureParity: parity((surface) => (performanceRows.has(surface) ? "Partial" : "Done")),
    readme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
    packagedReadme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
    ...overrides
  });
}

function releaseVsixEntries(packageJson = stablePackage) {
  return new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    ["extension.vsixmanifest", manifest()],
    ["extension/package.json", JSON.stringify(packageJson)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`],
    ["extension/changelog.md", "# Changelog\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Third-party notices\n"],
    ["extension/dist/extension/activate.js", 'require("vscode");'],
    ["extension/dist/extension/webviewPanel.js", "const policy = `font-src ${webview.cspSource};`;"],
    [VENDORED_JS_YAML_ENTRY, vendoredJsYaml],
    ["extension/media/webview.js", "export {};"],
    ["extension/media/webview.css", "@font-face{src:url('./codicon.ttf')}"],
    ["extension/media/codicon.ttf", "font"],
    ["extension/media/codePreview.js", "export {};"],
    ["extension/media/notebookRenderer.js", "export function activate() {}"],
    ["extension/media/action-icon-dark.svg", "<svg></svg>"],
    ["extension/media/action-icon-light.svg", "<svg></svg>"],
    ["extension/media/activity-icon.svg", "<svg></svg>"],
    ["extension/media/icon.png", "icon"],
    ["extension/media/icon-128.png", "icon"],
    ["extension/r/openwrangler_runtime/frame_contract.R", "openwrangler_frame_contract <- function(frame) frame\n"],
    ["extension/r/openwrangler_runtime/interactive_agent.R", "openwrangler_r_interactive_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/kernel_agent.R", "openwrangler_kernel_agent <- list()\n"],
    ["extension/r/openwrangler_runtime/process_agent.R", 'quit(save = "no")\n'],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n']
  ]);
}

function createReleaseVsixBuffer({ entryModes = new Map(), entries = releaseVsixEntries(), omitted = new Set() } = {}) {
  const zip = new ZipFile();
  for (const [name, contents] of entries) {
    if (!omitted.has(name)) {
      zip.addBuffer(Buffer.isBuffer(contents) ? contents : Buffer.from(contents), name, {
        mode: entryModes.get(name)
      });
    }
  }

  return new Promise((resolveBytes, rejectBytes) => {
    const chunks = [];
    let length = 0;
    zip.outputStream.on("data", (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
    });
    zip.outputStream.once("error", rejectBytes);
    zip.outputStream.once("end", () => resolveBytes(Buffer.concat(chunks, length)));
    zip.end();
  });
}

async function createReleaseVsix(path) {
  writeFileSync(path, await createReleaseVsixBuffer(), { flag: "wx", mode: 0o600 });
}

function patchZipEntry(bytes, entryName, patch) {
  const result = Buffer.from(bytes);
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  let offset = 0;
  while ((offset = result.indexOf(centralSignature, offset)) >= 0) {
    const nameLength = result.readUInt16LE(offset + 28);
    const extraLength = result.readUInt16LE(offset + 30);
    const commentLength = result.readUInt16LE(offset + 32);
    const name = result.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === entryName) {
      const localOffset = result.readUInt32LE(offset + 42);
      patch({ centralOffset: offset, localOffset, result });
      return result;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP test entry not found: ${entryName}`);
}

test("accepts one internally consistent stable release candidate", () => {
  assert.deepEqual(inspectStableReleaseReadiness(ready()), []);
});

test("binds the checked-in Native R preview table to its exact truthful structure", () => {
  assert.equal(Object.isFrozen(R_PREVIEW_PARITY_SCOPE), true);
  assert.equal(
    R_PREVIEW_PARITY_SCOPE.every((row) => Object.isFrozen(row)),
    true
  );
  assert.throws(() => {
    R_PREVIEW_PARITY_SCOPE[0][2] = "Done";
  }, TypeError);
  const checkedIn = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
  assert.deepEqual(inspectPreviewRParitySource({ featureParity: checkedIn }), []);
  assert.deepEqual(inspectPreviewRParitySource({ featureParity: previewRParity() }), []);

  const hiddenCanonicalTable = previewRParity().replace(/^## Native R preview\n+/u, "");
  for (const hidden of [`\`\`\`markdown\n${hiddenCanonicalTable}\n\`\`\``]) {
    assert.deepEqual(inspectPreviewRParitySource({ featureParity: `${previewRParity()}\n${hidden}\n` }), []);
  }

  const structuralMutations = [
    `${previewRParity()}\n## \u200bNative R archive\n`,
    previewRParity().replace("## Native R preview", "Native R preview\n---"),
    previewRParity().replace("## Native R preview", "### Native R preview"),
    previewRParity().replace("## Native R preview", "## ~~Native R preview~~"),
    previewRParity().replace("## Native R preview", "## Native R ~~preview~~"),
    previewRParity().replace("## Native R preview", "## Native R support"),
    `${previewRParity()}\n## Native R archive\n`,
    previewRParity().replace(
      "| Surface | Availability | Status | Current checks | Release check |",
      "| Surface | Status | Availability | Current checks | Release check |"
    ),
    previewRParity().replace("| Preview release |", "| Stable release |"),
    previewRParity().replace("| 1.99 preview |", "| Stable |"),
    previewRParity().replace("| Partial |", "| Planned |"),
    previewRParity().replace("| Partial |", "| ~~Partial~~ |"),
    previewRParity().replace("| Partial |", "| Partial ![Done](https://example.invalid/done.svg) |"),
    previewRParity().replace("| Surface |", "| `Surface` |"),
    previewRParity().replace(
      "| Native R frame paging and typed cells |",
      "| `Native R frame paging and typed cells` |"
    ),
    previewRParity().replace(
      "Linux local VS Code/Cursor and remote VS Code; macOS/Windows VS Code gate",
      "Tests did not pass."
    ),
    previewRParity().replace(R_PREVIEW_PARITY_SCOPE[0][0], `~~${R_PREVIEW_PARITY_SCOPE[0][0]}~~`),
    previewRParity().replace(
      "Current automated preview evidence remains truthful.",
      "~~Current automated preview evidence remains truthful.~~"
    ),
    previewRParity().replace(
      "## Native R preview\n",
      "## Native R preview\n\n<table><tr><td>decoy</td></tr></table>\n"
    ),
    `<div hidden>\n\n${previewRParity()}\n</div>\n`,
    `<details>\n\n${previewRParity()}\n</details>\n`,
    `<template>\n\n${previewRParity()}\n</template>\n`,
    `${previewRParity()}\n<!--\n${hiddenCanonicalTable}\n-->\n`,
    `${previewRParity()}\n<!--><style>table{display:none!important}</style><!-- -->\n`,
    previewRParity().replace("## Native R preview\n", "## Native R preview\n\n### Deferred\n")
  ];
  for (const mutated of structuralMutations) {
    assert.notDeepEqual(inspectPreviewRParitySource({ featureParity: mutated }), []);
  }

  assert.notDeepEqual(
    inspectPreviewRParitySource({
      featureParity: previewRParity({
        currentChecks: "Will add evidence later.",
        status: (surface) => (surface === R_PREVIEW_PARITY_SCOPE[0][0] ? "Done" : "Partial")
      })
    }),
    []
  );
  for (const surface of [
    "Native R frame paging and typed cells",
    "Base data.frame, tibble, and data.table",
    "R cleaning operations and generated code",
    "Owned .R source process"
  ]) {
    assert.notDeepEqual(
      inspectPreviewRParitySource({
        featureParity: previewRParity({
          status: (candidateSurface) =>
            candidateSurface === surface
              ? "Done"
              : R_PREVIEW_PARITY_SCOPE.find(([name]) => name === candidateSurface)[2]
        })
      }),
      []
    );
  }

  for (let index = 0; index < R_PREVIEW_PARITY_SCOPE.length; index += 1) {
    const deleted = R_PREVIEW_PARITY_SCOPE.filter((_, candidateIndex) => candidateIndex !== index);
    assert.notDeepEqual(inspectPreviewRParitySource({ featureParity: previewRParity({ scope: deleted }) }), []);
    if (index + 1 < R_PREVIEW_PARITY_SCOPE.length) {
      const swapped = R_PREVIEW_PARITY_SCOPE.map((row) => row);
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      assert.notDeepEqual(inspectPreviewRParitySource({ featureParity: previewRParity({ scope: swapped }) }), []);
    }
  }
});

test("requires the exact all-Done Native R scope for stable 2.x source and candidate readiness", () => {
  const stableFeatureParity = `${parity()}\n${stableRParity()}`;
  const trackedEvidencePaths = new Set([...ready().trackedEvidencePaths, ...stableRTrackedEvidencePaths()]);

  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: parity(),
      readme: ready().readme,
      trackedEvidencePaths: ready().trackedEvidencePaths,
      version: "1.2.2"
    }),
    []
  );
  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: stableFeatureParity,
      readme: ready().readme,
      trackedEvidencePaths,
      version: stableV2Version
    }),
    []
  );
  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: stableFeatureParity,
      readme: ready().readme,
      trackedEvidencePaths,
      version: "3.0.0"
    }),
    []
  );
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: parity(),
      readme: ready().readme,
      trackedEvidencePaths: ready().trackedEvidencePaths,
      version: "3.0.0"
    }).some((problem) => problem.includes('"## Native R support"'))
  );
  assert.deepEqual(inspectStableReleaseReadiness(stableV2Ready()), []);
  const crlfReadme = ready().readme.replace(/\n/gu, "\r\n");
  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: stableFeatureParity,
      readme: crlfReadme,
      trackedEvidencePaths,
      version: stableV2Version
    }),
    []
  );
  assert.deepEqual(
    inspectStableReleaseReadiness(
      stableV2Ready({
        packagedReadme: stableV2Readme.replace(/\n/gu, "\r\n"),
        readme: stableV2Readme.replace(/\n/gu, "\r\n")
      })
    ),
    []
  );

  for (const version of [
    undefined,
    "2",
    "2.0",
    "02.0.0",
    "2.0.0-beta.1",
    Object("2.0.0"),
    ["2.0.0"],
    { toString: () => "2.0.0" }
  ]) {
    assert.ok(
      inspectStableSourceReadiness({
        featureParity: stableFeatureParity,
        readme: ready().readme,
        trackedEvidencePaths,
        version
      }).includes("Stable source version must use major.minor.patch syntax.")
    );
  }
  for (const version of ["0.3.0", "1.99.0"]) {
    assert.ok(
      inspectStableSourceReadiness({
        featureParity: parity(),
        readme: ready().readme,
        trackedEvidencePaths: ready().trackedEvidencePaths,
        version
      }).includes(`Stable source version ${version} is reserved for preview releases.`)
    );
  }

  for (const featureParity of [parity(), `${parity()}\n${previewRParity()}`]) {
    const isPreviewShaped = featureParity.includes("## Native R preview");
    const expectedRProblem = (problem) =>
      isPreviewShaped
        ? problem.includes("must not contain active preview-era Native R copy")
        : problem.includes('"## Native R support"');
    assert.ok(
      inspectStableSourceReadiness({
        featureParity,
        readme: ready().readme,
        trackedEvidencePaths,
        version: stableV2Version
      }).some(expectedRProblem)
    );
    assert.ok(inspectStableReleaseReadiness(stableV2Ready({ featureParity })).some(expectedRProblem));
  }

  const primaryPartial = inspectStableReleaseReadiness(
    stableV2Ready({ featureParity: `${parity("Partial")}\n${stableRParity()}` })
  );
  assert.ok(primaryPartial.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));
});

test("dispatches source documentation only after exact version and preview-channel agreement", () => {
  const stableFeatureParity = `${parity()}\n${stableRParity()}`;
  const trackedEvidencePaths = new Set([...ready().trackedEvidencePaths, ...stableRTrackedEvidencePaths()]);
  assert.deepEqual(
    inspectReleaseDocumentationSource({
      featureParity: previewRParity(),
      preview: true,
      readme: `# Open Wrangler\n\n${PREVIEW_README_RELEASE_SECTION}\n`,
      version: "1.99.5"
    }),
    []
  );
  assert.deepEqual(
    inspectReleaseDocumentationSource({
      featureParity: stableFeatureParity,
      preview: false,
      readme: ready().readme,
      trackedEvidencePaths,
      version: stableV2Version
    }),
    []
  );
  for (const input of [
    { version: stableV2Version, preview: true },
    { version: "1.99.5", preview: false },
    { version: stableV2Version, preview: "true" },
    { version: stableV2Version, preview: 1 },
    { version: "2.0", preview: false }
  ]) {
    assert.notDeepEqual(
      inspectReleaseDocumentationSource({
        featureParity: previewRParity(),
        readme: `# Open Wrangler\n\n${PREVIEW_README_RELEASE_SECTION}\n`,
        ...input
      }),
      []
    );
  }
});

test("rejects structural and semantic drift in the stable Native R matrix", () => {
  const inspect = (rTable, trackedEvidencePaths = stableRTrackedEvidencePaths()) =>
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${rTable}`,
      readme: ready().readme,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...trackedEvidencePaths]),
      version: stableV2Version
    });

  assert.deepEqual(inspect(stableRParity()), []);
  assert.deepEqual(R_STABLE_PARITY_SCOPE, expectedStableRScope);
  const hiddenCanonicalTable = stableRParity().replace(/^## Native R support\n+/u, "");

  const structuralMutations = [
    `${stableRParity()}\n\`\`\`markdown\n${hiddenCanonicalTable}\n\`\`\``,
    `${stableRParity()}\n## \u200eNative R archive\n`,
    stableRParity().replace("## Native R support", "Native R support\n---"),
    stableRParity().replace("## Native R support", "### Native R support"),
    stableRParity().replace("## Native R support", "## ~~Native R support~~"),
    stableRParity().replace("## Native R support", "## Native R ~~support~~"),
    stableRParity().replace("## Native R support", "## Native R stable parity"),
    `${stableRParity()}\n## Native R archive\n`,
    `${stableRParity()}\n## Native r archive\n`,
    stableRParity().replace(
      "| Surface | Availability | Status | Required evidence | Release gate |",
      "| Surface | Status | Availability | Required evidence | Release gate |"
    ),
    stableRParity().replace("| Stable release |", "| Preview release |"),
    stableRParity().replace("| Done |", "| Partial |"),
    stableRParity().replace("| Done |", "| ~~Done~~ |"),
    stableRParity().replace("| Done |", "| Done ![Partial](https://example.invalid/partial.svg) |"),
    stableRParity().replace("| Surface |", "| `Surface` |"),
    stableRParity().replace("| Native R frame paging and typed cells |", "| `Native R frame paging and typed cells` |"),
    stableRParity().replace(
      "| Exact active R-terminal transport | Linux |",
      "| Exact active R-terminal transport | Linux, macOS, and Windows |"
    ),
    stableRParity().replace(
      "| Cursor .Rmd document command and .qmd R/Python chunk actions | Linux |",
      "| Cursor-owned .Rmd and .qmd R/Python chunks | Linux and macOS |"
    ),
    stableRParity().replace("test:r/tests/complete_catalog_contract.R", "test:r/tests/frame_contract.R"),
    stableRParity().replace(
      "test:src/test/rCompleteCatalogCodeExport.unit.test.ts",
      "test:src/test/rKernelBridge.unit.test.ts"
    ),
    stableRParity().replace(
      "| Active R-terminal cleaned-data export | Linux |",
      "| Active R-terminal cleaned-data export | Linux, macOS, and Windows |"
    ),
    stableRParity().replace(
      "Exact stable acceptance passed and is recorded;",
      '[Exact stable acceptance passed and is recorded](https://example.invalid/unreviewed "tests did not pass");'
    ),
    stableRParity().replace(R_STABLE_PARITY_SCOPE[0].surface, `~~${R_STABLE_PARITY_SCOPE[0].surface}~~`),
    stableRParity().replace(
      "Exact stable acceptance passed and is recorded;",
      "~~Exact stable acceptance passed and is recorded;~~"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99 preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99.5 preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99.x preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99-preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99.5-preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99\u2011preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99.5\u2013preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99 (preview) remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99 ![preview](https://example.invalid/preview.svg) remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99\u200bpreview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.\u034f99 preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.\ufe0f99 preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99         preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99.........preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99-era preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 1.99 series preview remains supported.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOther cleaning operations are not available in R yet.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nBefore a 2.0 tag can be published, acceptance must pass.\n"
    ),
    stableRParity().replace(
      "## Native R support\n",
      "## Native R support\n\nOpen Wrangler 2.0 previews remain supported.\n"
    ),
    `${stableRParity()}\n## R limitations\n\nOther cleaning operations are not available in R yet.\n`,
    `${stableRParity()}\n## R roadmap\n\nBefore a 2.0 tag can be published, acceptance must pass.\n`,
    `${stableRParity()}\n## R status\n\nOpen Wrangler 2.0 previews remain supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler v1.99 preview remains supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler version1.99 preview remains supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler 1.\u007f99 preview remains supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler 1.\ufff999 preview remains supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler 1.99\u3164release preview remains supported.\n`,
    `${stableRParity()}\n## R history\n\nOpen Wrangler \u202eweiverp 99.1\u202c remains supported.\n`,
    `${stableRParity()}\n## History\n\n![Open Wrangler 1.**99** preview](https://example.invalid/preview.svg)\n`,
    `${stableRParity()}\n## R preview archive\n\nOpen Wrangler 1.99.5 preview remains supported.\n`,
    `${stableRParity()}\n## Something else\n\n${previewRParity()}\n`,
    stableRParity().replace("## Native R support\n", "## Native R support\n\n<table><tr><td>decoy</td></tr></table>\n"),
    `<div hidden>\n\n${stableRParity()}\n</div>\n`,
    `<details>\n\n${stableRParity()}\n</details>\n`,
    `<template>\n\n${stableRParity()}\n</template>\n`,
    `${stableRParity()}\n<!--\n${hiddenCanonicalTable}\n-->\n`,
    `${stableRParity()}\n<!--><style>table{display:none!important}</style><!-- -->\n`,
    stableRParity().replace("## Native R support\n", "## Native R support\n\n### Deferred\n")
  ];
  for (const [mutationIndex, mutated] of structuralMutations.entries()) {
    assert.notDeepEqual(inspect(mutated), [], `stable structural mutation ${mutationIndex} must fail closed`);
  }
  for (const unrelatedVersion of ["1.990", "1.99beta"]) {
    assert.deepEqual(
      inspect(`${stableRParity()}\n## History\n\nCompatibility note for format ${unrelatedVersion}.\n`),
      []
    );
  }

  for (let index = 0; index < R_STABLE_PARITY_SCOPE.length; index += 1) {
    const deleted = R_STABLE_PARITY_SCOPE.filter((_, candidateIndex) => candidateIndex !== index);
    assert.notDeepEqual(inspect(stableRParity({ scope: deleted })), []);

    const duplicated = R_STABLE_PARITY_SCOPE.flatMap((row, candidateIndex) =>
      candidateIndex === index ? [row, row] : [row]
    );
    assert.notDeepEqual(inspect(stableRParity({ scope: duplicated })), []);

    if (index + 1 < R_STABLE_PARITY_SCOPE.length) {
      const swapped = R_STABLE_PARITY_SCOPE.map((row) => row);
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      assert.notDeepEqual(inspect(stableRParity({ scope: swapped })), []);
    }
  }

  for (const mutated of [
    stableRParity().replace("All 28 catalog operations", "All 26 catalog operations"),
    stableRParity().replace("collapse::qDF()", "collapse frame"),
    stableRParity().replace("collapse::qTBL()", "collapse frame"),
    stableRParity().replace("collapse::qDT()", "collapse frame")
  ]) {
    assert.notDeepEqual(inspect(mutated), []);
  }
});

test("binds every stable Native R row to its exact reviewed tracked evidence", () => {
  const inspect = (rTable, trackedEvidencePaths = stableRTrackedEvidencePaths()) =>
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${rTable}`,
      readme: ready().readme,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...trackedEvidencePaths]),
      version: stableV2Version
    });

  for (const reference of new Set(R_STABLE_PARITY_SCOPE.flatMap((row) => row.evidence))) {
    const tracked = stableRTrackedEvidencePaths();
    tracked.delete(reference.slice(reference.indexOf(":") + 1));
    assert.notDeepEqual(inspect(stableRParity(), tracked), []);
  }

  const evidenceMutations = [
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.slice(1).join("; ")}`,
    (row) => `Will add stable acceptance later; ${row.evidence.join("; ")}`,
    (row) => `Exact stable acceptance did not pass; ${row.evidence.join("; ")}`,
    (row) => `Stable acceptance failed; ${row.evidence.join("; ")}`,
    (row) => `No acceptance evidence exists; ${row.evidence.join("; ")}`,
    (row) => `Tests were not run; ${row.evidence.join("; ")}`,
    (row) => `Never tested; ${row.evidence.join("; ")}`,
    (row) => `Evidence is available; ${row.evidence.join("; ")}`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}; ${row.evidence[0]}`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}#unreviewed`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}#`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}?unreviewed`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}@unreviewed`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}%23unreviewed`,
    (row) => `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}:unreviewed`,
    (row) =>
      `Exact stable acceptance passed and is recorded; ${row.evidence.slice(1).join("; ")}; test:scripts/release-readiness.test.mjs`,
    (row) =>
      `Exact stable acceptance passed and is recorded; ${row.evidence.join("; ")}; test:scripts/untracked.test.mjs`,
    (row) => `Exact stable acceptance passed and is recorded; test docs/testing.md; ${row.evidence.slice(1).join("; ")}`
  ];
  for (const mutation of evidenceMutations) {
    assert.notDeepEqual(inspect(stableRParity({ evidence: mutation })), []);
  }

  const first = R_STABLE_PARITY_SCOPE[0];
  const second = R_STABLE_PARITY_SCOPE[7];
  assert.notDeepEqual(
    inspect(
      stableRParity({
        evidence: (row) =>
          `Exact stable acceptance passed and is recorded; ${(row === first ? second.evidence : row.evidence).join("; ")}`
      })
    ),
    []
  );
  assert.notDeepEqual(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: ready().readme,
      trackedEvidencePaths: undefined,
      version: stableV2Version
    }),
    []
  );
});

test("stable public copy rejects leftover 1.99 preview labels", () => {
  assert.deepEqual(inspectStablePublicCopy("## R dataframes", "docs/media-gallery.md"), []);
  const expected =
    "docs/media-gallery.md still contains a 1.99 preview label. Remove it before the stable version 2 release.";
  const staleLabels = [
    "1.99 preview",
    "v1.99 preview",
    "1.99-preview",
    "1.99 (preview)",
    "1.99\u2011preview",
    "1.99 **preview**",
    "1.99 pre**view**",
    "1.99 [preview](https://example.invalid/preview)",
    "1.99 ![preview](https://example.invalid/preview.svg)",
    '1.99 <img alt="preview" src="https://example.invalid/preview.svg">',
    '<img alt="Open Wrangler 1.99 preview" src="https://example.invalid/preview.svg">',
    "1.99 <strong>preview</strong>",
    "1.99 `preview`",
    "1.99 version preview",
    "1.99.5 preview",
    "1.99-era preview",
    "1.99 release preview",
    "1.99 channel preview",
    "v1.99-era preview",
    "version1.99 preview",
    "OpenWrangler1.99 preview",
    "releasev1.99 preview",
    "Preview release 1.99",
    "The preview channel for Open Wrangler 1.99",
    "The preview era was Open Wrangler 1.99",
    "Open Wrangler preview v1.99"
  ];
  for (const staleLabel of staleLabels) {
    const contents = `## R dataframes (${staleLabel})`;
    assert.deepEqual(inspectStablePublicCopy(contents, "docs/media-gallery.md"), [expected]);
    assert.ok(
      inspectStableSourceReadiness({
        featureParity: `${parity()}\n${stableRParity()}`,
        readme: `${ready().readme}\n${contents}\n`,
        trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
        version: stableV2Version
      }).some((problem) => problem.includes("still contains a 1.99 preview label"))
    );
  }
  for (const renderedStaleLabel of [
    "<h2>R dataframes (Open Wrangler v1.99 pre<!-- inert -->view)</h2>",
    "<h2>R dataframes (Open Wrangler v1.99 pre<!-- a < b -->view)</h2>",
    "<h2>R dataframes (Open Wrangler v1.99 pre<!-->view)</h2>",
    "<h2>R dataframes (Open Wrangler v1.99 pre<?ignored>view)</h2>",
    "<h2>R dataframes (Open Wrangler v1.99 pre</>view)</h2>",
    "Open Wrangler v1.99 ![pre**view**](https://example.invalid/preview.svg)",
    'Open Wrangler v1.99<img alt="." width="0" height="0" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="> preview',
    "Open Wrangler v1.99 ![.](https://example.invalid/pixel.gif) preview",
    "<blockquote>Open Wrangler v1.99</blockquote><blockquote>preview</blockquote>",
    "<ul>Open Wrangler v1.99</ul><ul>preview</ul>",
    "<table>Open Wrangler v1.99</table><table>preview</table>"
  ]) {
    assert.deepEqual(inspectStablePublicCopy(renderedStaleLabel, "docs/media-gallery.md"), [expected]);
    assert.ok(
      inspectStableSourceReadiness({
        featureParity: `${parity()}\n${stableRParity()}`,
        readme: `${ready().readme}\n${renderedStaleLabel}\n`,
        trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
        version: stableV2Version
      }).some((problem) => problem.includes("still contains a 1.99 preview label"))
    );
  }
  for (const unsupportedHtml of [
    '<div style="display:inline">Open Wrangler v1.99</div><div style="display:inline"> preview</div>',
    "Open Wrangler v1.99<span hidden>.</span> preview remains supported.",
    'Open Wrangler v1.99<span style="display:none">.</span> preview remains supported.',
    '<style>.hidden { display: none }</style>Open Wrangler v1.99<span class="hidden">.</span> preview remains supported.',
    "Open Wrangler v1.99<script>.</script> preview remains supported."
  ]) {
    assert.ok(
      inspectStablePublicCopy(unsupportedHtml, "docs/media-gallery.md").some((problem) =>
        problem.includes("unsupported active HTML")
      )
    );
    assert.ok(
      inspectStableSourceReadiness({
        featureParity: `${parity()}\n${stableRParity()}`,
        readme: `${ready().readme}\n${unsupportedHtml}\n`,
        trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
        version: stableV2Version
      }).some((problem) => problem.includes("unsupported active HTML"))
    );
  }
  const ambiguousImageCopy =
    'Open Wrangler v1.99<img alt="." width="0" height="0" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="> pre<img alt="view" src="data:image/png;base64,AAAA">';
  assert.deepEqual(inspectStablePublicCopy(ambiguousImageCopy, "docs/media-gallery.md"), [expected]);
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: `${ready().readme}\n${ambiguousImageCopy}\n`,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
      version: stableV2Version
    }).some((problem) => problem.includes("still contains a 1.99 preview label"))
  );
  const bidiCopy = "Open Wrangler v1.99 \u202eweiverp\u202c remains supported.";
  assert.ok(
    inspectStablePublicCopy(bidiCopy, "docs/media-gallery.md").some((problem) =>
      problem.includes("bidirectional text controls")
    )
  );
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: `${ready().readme}\n${bidiCopy}\n`,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
      version: stableV2Version
    }).some((problem) => problem.includes("bidirectional text controls"))
  );
  const controlCopy = "Open Wrangler 1.\u007f99 preview remains supported.";
  assert.ok(
    inspectStablePublicCopy(controlCopy, "docs/media-gallery.md").some((problem) =>
      problem.includes("unsupported control characters")
    )
  );
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: `${ready().readme}\n${controlCopy}\n`,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
      version: stableV2Version
    }).some((problem) => problem.includes("unsupported control characters"))
  );
  const formatCopy = "Open Wrangler 1.\ufff999 preview remains supported.";
  assert.ok(
    inspectStablePublicCopy(formatCopy, "docs/media-gallery.md").some((problem) =>
      problem.includes("Unicode format characters")
    )
  );
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: `${ready().readme}\n${formatCopy}\n`,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
      version: stableV2Version
    }).some((problem) => problem.includes("Unicode format characters"))
  );
  const ignorableCopy = "Open Wrangler 1.99\u3164release preview remains supported.";
  assert.ok(
    inspectStablePublicCopy(ignorableCopy, "docs/media-gallery.md").some((problem) =>
      problem.includes("default-ignorable characters")
    )
  );
  assert.ok(
    inspectStableSourceReadiness({
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: `${ready().readme}\n${ignorableCopy}\n`,
      trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
      version: stableV2Version
    }).some((problem) => problem.includes("default-ignorable characters"))
  );
  for (const unrelatedVersion of ["1.990", "1.99beta"]) {
    const copy = `Compatibility note for format ${unrelatedVersion}.`;
    assert.deepEqual(inspectStablePublicCopy(copy, "docs/media-gallery.md"), []);
    assert.deepEqual(
      inspectStableSourceReadiness({
        featureParity: `${parity()}\n${stableRParity()}`,
        readme: `${ready().readme}\n${copy}\n`,
        trackedEvidencePaths: new Set(["scripts/release-readiness.test.mjs", ...stableRTrackedEvidencePaths()]),
        version: stableV2Version
      }),
      []
    );
  }
  assert.deepEqual(inspectStablePublicCopy("<!-- Open Wrangler v1.99 preview -->", "docs/media-gallery.md"), []);
  assert.deepEqual(inspectStablePublicCopy("```text\nOpen Wrangler v1.99 preview\n```", "docs/media-gallery.md"), []);

  const problems = inspectStableReleaseReadiness(
    ready({ readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n## R (1.99 preview)\n` })
  );
  assert.ok(
    problems.includes("README.md still contains a 1.99 preview label. Remove it before the stable version 2 release.")
  );
});

test("keeps release numbers in the dated performance report", () => {
  assert.deepEqual(
    inspectPerformanceSummary(
      "# Open Wrangler\n\n## Performance\n\nOur latest reviewed comparison found faster notebook previews.\n"
    ),
    []
  );
  assert.deepEqual(
    inspectPerformanceSummary(
      "# Open Wrangler\n\n## Performance\n\nOpen Wrangler 1.2.1 was faster for notebook previews.\n"
    ),
    ["README Performance prose must keep release numbers in the dated report link."]
  );
  assert.deepEqual(
    inspectPerformanceSummary("# Open Wrangler\n\n## Performance\n\nThe comparison used Data Wrangler 1.24.2.\n"),
    ["README Performance prose must keep release numbers in the dated report link."]
  );
  assert.deepEqual(
    inspectPerformanceSummary(
      "# Open Wrangler\n\n## Performance\n\n| Product | Time |\n| --- | ---: |\n| Open Wrangler | 1 s |\n"
    ),
    ["README Performance must link to detailed results instead of embedding a table."]
  );
});

test("requires one tracked, release-matched Data Wrangler review in the stable Performance section", () => {
  const version = "2.0.0";
  const reportPath = (reportVersion) => `docs/performance/data-wrangler-${reportVersion}/review.md`;
  const reportDataPath = (reportVersion) => `docs/performance/data-wrangler-${reportVersion}/report.json`;
  const reportUrl = (reportVersion) =>
    `https://github.com/Matt17BR/openwrangler/blob/main/${reportPath(reportVersion)}`;
  const readmeWithReport = (reportVersion, prefix = "") =>
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${prefix}## Performance\n\n[dated report](${reportUrl(reportVersion)})\n`;
  const reportSources = new Map();
  const reportSource = (reportVersion, sha256 = COMPARISON_TEST_SHA) => {
    const key = `${reportVersion}:${sha256}`;
    if (!reportSources.has(key)) {
      reportSources.set(key, JSON.stringify(createReleaseComparisonReport({ version: reportVersion, sha256 })));
    }
    return reportSources.get(key);
  };
  const candidate = (reportVersion, overrides = {}, sourceVersion = version) =>
    ready({
      releaseTag: `v${sourceVersion}`,
      sourcePackageJson: JSON.stringify({ ...stablePackage, version: sourceVersion }),
      pythonVersionFile: `__version__ = "${sourceVersion}"\n`,
      changelog: `# Changelog\n\n## [${sourceVersion}] - 2026-08-08\n\n### Added\n\n- Published R support.\n`,
      featureParity: `${parity()}\n${stableRParity()}`,
      readme: readmeWithReport(reportVersion),
      packagedPackageJson: JSON.stringify({ ...stablePackage, version: sourceVersion }),
      packagedPythonVersionFile: `__version__ = "${sourceVersion}"\n`,
      packagedReadme: readmeWithReport(reportVersion),
      trackedEvidencePaths: new Set([
        ...ready().trackedEvidencePaths,
        ...stableRTrackedEvidencePaths(),
        reportPath(reportVersion),
        reportDataPath(reportVersion)
      ]),
      performanceReportFiles: new Map([[reportDataPath(reportVersion), reportSource(reportVersion)]]),
      candidateSha256: COMPARISON_TEST_SHA,
      vsixManifest: manifest({ version: sourceVersion }),
      ...overrides
    });

  assert.deepEqual(inspectStableReleaseReadiness(candidate(version)), []);
  assert.deepEqual(inspectStableReleaseReadiness(candidate("2.0.0", {}, "2.0.1")), []);

  const historical = `[historical report](${reportUrl("1.2.1")})\n\n`;
  assert.deepEqual(
    inspectStableReleaseReadiness(
      candidate(version, {
        readme: readmeWithReport(version, historical),
        packagedReadme: readmeWithReport(version, historical)
      })
    ),
    []
  );

  const sourceProblems = inspectStableReleaseReadiness(
    candidate(version, {
      readme: readmeWithReport("1.2.1"),
      trackedEvidencePaths: new Set([
        ...ready().trackedEvidencePaths,
        reportPath("1.2.1"),
        reportPath(version),
        reportDataPath(version)
      ])
    })
  );
  assert.ok(
    sourceProblems.includes(
      "README.md Performance report version 1.2.1 does not cover source release line 2.0.x at 2.0.0."
    )
  );

  const packagedProblems = inspectStableReleaseReadiness(
    candidate(version, {
      packagedReadme: readmeWithReport("1.2.1"),
      trackedEvidencePaths: new Set([
        ...ready().trackedEvidencePaths,
        reportPath("1.2.1"),
        reportPath(version),
        reportDataPath(version)
      ])
    })
  );
  assert.ok(
    packagedProblems.includes(
      "Packaged README Performance report version 1.2.1 does not cover source release line 2.0.x at 2.0.0."
    )
  );

  const futureReportProblems = inspectStableReleaseReadiness(candidate("2.0.1"));
  assert.ok(
    futureReportProblems.includes(
      "README.md Performance report version 2.0.1 does not cover source release line 2.0.x at 2.0.0."
    )
  );

  const untrackedProblems = inspectStableReleaseReadiness(
    candidate(version, { trackedEvidencePaths: ready().trackedEvidencePaths })
  );
  for (const label of ["README.md", "Packaged README"]) {
    assert.ok(untrackedProblems.includes(`${label} Performance report ${reportPath(version)} must be tracked.`));
    assert.ok(untrackedProblems.includes(`${label} Performance data ${reportDataPath(version)} must be tracked.`));
  }

  const missingDataProblems = inspectStableReleaseReadiness(
    candidate(version, {
      trackedEvidencePaths: new Set([...ready().trackedEvidencePaths, reportPath(version)])
    })
  );
  for (const label of ["README.md", "Packaged README"]) {
    assert.ok(missingDataProblems.includes(`${label} Performance data ${reportDataPath(version)} must be tracked.`));
  }

  const missingSourceProblems = inspectStableReleaseReadiness(
    candidate(version, { performanceReportFiles: new Map() })
  );
  assert.ok(
    missingSourceProblems.includes(
      `README.md Performance data ${reportDataPath(version)} must be read from the release commit.`
    )
  );

  const malformedSourceProblems = inspectStableReleaseReadiness(
    candidate(version, { performanceReportFiles: new Map([[reportDataPath(version), "{"]]) })
  );
  assert.ok(
    malformedSourceProblems.includes(
      `README.md Performance data ${reportDataPath(version)} must contain valid bounded JSON.`
    )
  );

  const truncatedSourceProblems = inspectStableReleaseReadiness(
    candidate(version, {
      performanceReportFiles: new Map([
        [
          reportDataPath(version),
          JSON.stringify({
            provenance: { openWrangler: { version, sha256: COMPARISON_TEST_SHA } }
          })
        ]
      ])
    })
  );
  assert.ok(
    truncatedSourceProblems.some((problem) =>
      problem.startsWith(`README.md Performance data ${reportDataPath(version)} is incomplete or invalid:`)
    )
  );

  const copiedOldSourceProblems = inspectStableReleaseReadiness(
    candidate(version, {
      performanceReportFiles: new Map([[reportDataPath(version), reportSource("1.2.1")]])
    })
  );
  assert.ok(
    copiedOldSourceProblems.includes(
      `README.md Performance data ${reportDataPath(version)} describes Open Wrangler 1.2.1, not ${version}.`
    )
  );

  const wrongCandidateProblems = inspectStableReleaseReadiness(
    candidate(version, {
      performanceReportFiles: new Map([[reportDataPath(version), reportSource(version, "b".repeat(64))]])
    })
  );
  assert.ok(
    wrongCandidateProblems.includes(
      `README.md Performance data ${reportDataPath(version)} does not match the release candidate VSIX.`
    )
  );

  assert.deepEqual(
    inspectStableReleaseReadiness(
      candidate(
        "2.0.0",
        {
          candidateSha256: "b".repeat(64)
        },
        "2.0.1"
      )
    ),
    []
  );

  const missingCurrentReport = inspectStableReleaseReadiness(
    candidate(version, {
      readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${historical}`
    })
  );
  assert.ok(
    missingCurrentReport.includes("README.md Performance section must link exactly one versioned Data Wrangler review.")
  );

  const duplicateCurrentReport = inspectStableReleaseReadiness(
    candidate(version, {
      packagedReadme: `${readmeWithReport(version)}\n[second report](${reportUrl(version)})\n`
    })
  );
  assert.ok(
    duplicateCurrentReport.includes(
      "Packaged README Performance section must link exactly one versioned Data Wrangler review."
    )
  );

  const v1Candidate = candidate("1.2.1", {
    releaseTag: "v1.2.2",
    sourcePackageJson: JSON.stringify({ ...stablePackage, version: "1.2.2" }),
    pythonVersionFile: '__version__ = "1.2.2"\n',
    changelog: "# Changelog\n\n## [1.2.2] - 2026-08-08\n\n### Fixed\n\n- Updated the extension.\n",
    packagedPackageJson: JSON.stringify({ ...stablePackage, version: "1.2.2" }),
    packagedPythonVersionFile: '__version__ = "1.2.2"\n',
    vsixManifest: manifest({ version: "1.2.2" })
  });
  assert.deepEqual(inspectStableReleaseReadiness(v1Candidate), []);
});

test("performance-evidence readiness permits only the two exact performance rows to remain Partial", () => {
  const performanceRows = new Set(PERFORMANCE_EVIDENCE_PARTIAL_ROWS);
  const featureParity = parity((surface) => (performanceRows.has(surface) ? "Partial" : "Done"));

  assert.deepEqual(inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady({ featureParity })), []);
  assert.deepEqual(
    inspectStableReleaseReadiness(ready({ featureParity })).filter((problem) =>
      /^Parity row ".+" is Partial, not Done\.$/u.test(problem)
    ),
    PERFORMANCE_EVIDENCE_PARTIAL_ROWS.map((surface) => `Parity row "${surface}" is Partial, not Done.`)
  );

  const unrelatedPartial = parity((surface) =>
    surface === "Dataset summary and quick insights" || performanceRows.has(surface) ? "Partial" : "Done"
  );
  assert.ok(
    inspectPerformanceEvidenceCandidateReadiness(
      performanceEvidenceReady({ featureParity: unrelatedPartial })
    ).includes('Parity row "Dataset summary and quick insights" is Partial, not Done.')
  );

  for (const surface of PERFORMANCE_EVIDENCE_PARTIAL_ROWS) {
    const planned = parity((candidate) => (candidate === surface ? "Planned" : "Done"));
    assert.ok(
      inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady({ featureParity: planned })).includes(
        `Parity row "${surface}" is Planned, not Done.`
      )
    );
  }

  const missingProgressEvidence = featureParity.replace(
    "| Virtual grid, column sizing, navigation | Yes | Yes | Partial | Exact package acceptance; test:scripts/release-readiness.test.mjs |",
    "| Virtual grid, column sizing, navigation | Yes | Yes | Partial | TODO |"
  );
  assert.ok(
    inspectPerformanceEvidenceCandidateReadiness(
      performanceEvidenceReady({ featureParity: missingProgressEvidence })
    ).includes(
      'Parity row "Virtual grid, column sizing, navigation" must record acceptance progress plus a valid tracked test:, workflow:, or record: reference.'
    )
  );

  const invalidMetadata = inspectPerformanceEvidenceCandidateReadiness(
    performanceEvidenceReady({
      featureParity,
      sourcePackageJson: JSON.stringify({ ...stablePackage, preview: true })
    })
  );
  assert.ok(invalidMetadata.includes("Source package.json preview must be false for a stable release."));
});

test("keeps performance evidence truthful and non-interchangeable with stable readiness", () => {
  assert.deepEqual(inspectPerformanceEvidenceCandidateReadiness(performanceEvidenceReady()), []);

  const stableReadmeInEvidenceMode = inspectPerformanceEvidenceCandidateReadiness(
    performanceEvidenceReady({
      readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`,
      packagedReadme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`
    })
  );
  assert.ok(
    stableReadmeInEvidenceMode.some((problem) =>
      problem.includes("exact generated performance-evidence candidate release/install region")
    )
  );

  const evidenceReadmeInStableMode = inspectStableReleaseReadiness(
    ready({
      readme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`,
      packagedReadme: `# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`
    })
  );
  assert.ok(
    evidenceReadmeInStableMode.some((problem) => problem.includes("exact generated stable release/install region"))
  );

  const completedRows = performanceEvidenceReady({ featureParity: parity() });
  const completedProblems = inspectPerformanceEvidenceCandidateReadiness(completedRows);
  for (const surface of PERFORMANCE_EVIDENCE_PARTIAL_ROWS) {
    assert.ok(
      completedProblems.includes(
        `Parity row "${surface}" must remain Partial while authoring performance evidence; received Done.`
      )
    );
  }

  assert.deepEqual(
    inspectPerformanceEvidenceSourceReadiness({
      featureParity: performanceEvidenceReady().featureParity,
      readme: performanceEvidenceReady().readme,
      trackedEvidencePaths: performanceEvidenceReady().trackedEvidencePaths,
      version: PERFORMANCE_EVIDENCE_VERSION
    }),
    []
  );
  assert.deepEqual(
    inspectStableSourceReadiness({
      featureParity: ready().featureParity,
      readme: ready().readme,
      trackedEvidencePaths: ready().trackedEvidencePaths,
      version: stablePackage.version
    }),
    []
  );
  assert.deepEqual(
    inspectPerformanceEvidenceReadme(`# Open Wrangler\n\n${PERFORMANCE_EVIDENCE_README_RELEASE_SECTION}\n`),
    []
  );
});

test("limits the temporary performance-evidence narrative and workflow to 1.0.0", () => {
  for (const version of ["1.1.0", "2.0.0"]) {
    const candidate = performanceEvidenceReady({
      releaseTag: `v${version}`,
      sourcePackageJson: JSON.stringify({ ...stablePackage, version }),
      pythonVersionFile: `__version__ = "${version}"\n`,
      packagedPackageJson: JSON.stringify({ ...stablePackage, version }),
      packagedPythonVersionFile: `__version__ = "${version}"\n`,
      vsixManifest: manifest({ version })
    });
    assert.ok(
      inspectPerformanceEvidenceCandidateReadiness(candidate).includes(
        `Performance-evidence authoring is limited to version ${PERFORMANCE_EVIDENCE_VERSION}.`
      )
    );
    assert.ok(
      inspectPerformanceEvidenceSourceReadiness({
        featureParity: candidate.featureParity,
        readme: candidate.readme,
        trackedEvidencePaths: candidate.trackedEvidencePaths,
        version
      }).includes(`Performance-evidence authoring is limited to version ${PERFORMANCE_EVIDENCE_VERSION}.`)
    );
  }
});

test("binds numeric release versions to their channel before workflow branching", () => {
  for (const accepted of [
    { releaseTag: "v0.3.0", version: "0.3.0", preview: true },
    { releaseTag: "v1.0.0", version: "1.0.0", preview: false },
    { releaseTag: "v1.1.0", version: "1.1.0", preview: false },
    { releaseTag: "v1.98.999", version: "1.98.999", preview: false },
    { releaseTag: "v1.99.0", version: "1.99.0", preview: true },
    { releaseTag: "v1.99.999", version: "1.99.999", preview: true },
    { releaseTag: "v1.100.0", version: "1.100.0", preview: false },
    { releaseTag: "v2.0.0", version: "2.0.0", preview: false }
  ]) {
    const result = inspectReleaseMetadata({
      releaseTag: accepted.releaseTag,
      packageJson: JSON.stringify({ version: accepted.version, preview: accepted.preview })
    });
    assert.deepEqual(result.problems, []);
    assert.equal(result.prerelease, accepted.preview);
  }

  const stableNumberMarkedPreview = inspectReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: true })
  });
  assert.ok(
    stableNumberMarkedPreview.problems.includes(
      'Version 1.0.0 is not a permitted preview-channel number and requires package.json "preview" to be false.'
    )
  );

  const previewNumberMarkedStable = inspectReleaseMetadata({
    releaseTag: "v0.3.0",
    packageJson: JSON.stringify({ version: "0.3.0", preview: false })
  });
  assert.ok(
    previewNumberMarkedStable.problems.includes(
      'Preview-channel version 0.3.0 requires package.json "preview" to be true.'
    )
  );

  const evenZeroMinorMarkedPreview = inspectReleaseMetadata({
    releaseTag: "v0.4.0",
    packageJson: JSON.stringify({ version: "0.4.0", preview: true })
  });
  assert.ok(
    evenZeroMinorMarkedPreview.problems.includes(
      'Version 0.4.0 is not a permitted preview-channel number and requires package.json "preview" to be false.'
    )
  );

  const v2PreviewNumberMarkedStable = inspectReleaseMetadata({
    releaseTag: "v1.99.0",
    packageJson: JSON.stringify({ version: "1.99.0", preview: false })
  });
  assert.ok(
    v2PreviewNumberMarkedStable.problems.includes(
      'Preview-channel version 1.99.0 requires package.json "preview" to be true.'
    )
  );

  for (const version of ["1.1.0", "1.98.999", "1.100.0", "2.0.0"]) {
    const stableNumberMarkedPreview = inspectReleaseMetadata({
      releaseTag: `v${version}`,
      packageJson: JSON.stringify({ version, preview: true })
    });
    assert.ok(
      stableNumberMarkedPreview.problems.includes(
        `Version ${version} is not a permitted preview-channel number and requires package.json "preview" to be false.`
      )
    );
  }
});

test("binds every future release to protected main and recognizes the historical cutoff", () => {
  for (const version of ["0.3.0", "0.4.0", "1.0.0", "1.2.1", "1.2.3", "1.99.0", "2.0.0", "3.4.5"]) {
    assert.deepEqual(releaseSourcePolicyForVersion(version), {
      branch: "main",
      ref: "refs/heads/main",
      version
    });
  }
  for (const version of ["0.3.0", "1.0.0", "1.2.1", "1.2.2"]) {
    assert.equal(isHistoricalTagRecoveryVersion(version), true);
  }
  for (const version of ["1.2.3", "1.3.0", "1.99.0", "2.0.0"]) {
    assert.equal(isHistoricalTagRecoveryVersion(version), false);
  }
  for (const version of [undefined, "1", "01.2.3", "1.2.3-beta.1"]) {
    assert.equal(releaseSourcePolicyForVersion(version), undefined);
    assert.equal(isHistoricalTagRecoveryVersion(version), false);
  }
});

test("accepts only preview metadata in the tag-release workflow gate", () => {
  for (const version of ["0.3.0", "1.99.0"]) {
    assert.deepEqual(
      inspectPreviewReleaseMetadata({
        releaseTag: `v${version}`,
        packageJson: JSON.stringify({ version, preview: true })
      }).problems,
      []
    );
  }

  const stable = inspectPreviewReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: false })
  });
  assert.ok(
    stable.problems.includes(
      "The tag release workflow is preview-only; stable publication must promote provenance-bound tested artifacts without rebuilding them."
    )
  );
});

test("retains canonical stable-candidate metadata mode beside the exact preview-only mode", () => {
  const stable = {
    releaseTag: "v1.0.0",
    packageJson: JSON.stringify({ version: "1.0.0", preview: false })
  };
  assert.deepEqual(inspectWorkflowReleaseMetadata(stable, undefined).problems, []);
  assert.ok(
    inspectWorkflowReleaseMetadata(stable, "--preview-only").problems.includes(
      "The tag release workflow is preview-only; stable publication must promote provenance-bound tested artifacts without rebuilding them."
    )
  );
  assert.throws(
    () => inspectWorkflowReleaseMetadata(stable, "--stable-only"),
    /accepts only its stable-candidate mode or the exact --preview-only tag mode/u
  );
});

test("rejects duplicate release metadata keys before choosing a workflow branch", () => {
  const result = inspectReleaseMetadata({
    releaseTag: "v1.0.0",
    packageJson: '{"version":"0.3.0","version":"1.0.0","preview":false}'
  });
  assert.ok(result.problems.includes("package.json must not contain duplicate object keys."));
  assert.equal(result.prerelease, undefined);
});

test("requires every primary Pandas/Polars parity row to be Done", () => {
  const problems = inspectStableReleaseReadiness(ready({ featureParity: parity("Partial") }));
  assert.ok(problems.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));

  const malformed = inspectStableReleaseReadiness(
    ready({
      featureParity: `| Surface | Pandas | Polars | Status | Required evidence |
| --- | --- | --- | --- | --- |
broken
`
    })
  );
  assert.ok(malformed.some((problem) => problem.includes("malformed row")));
});

test("reads exactly one active primary parity table from its top-level section", () => {
  const partialTable = parity("Partial");
  for (const hiddenDoneTable of [
    `\`\`\`markdown\n${parity()}\`\`\`\n`,
    `<!--\n${parity()}-->\n`,
    `<div hidden>\n<table><tr><th>Surface</th><th>Pandas</th><th>Polars</th><th>Status</th><th>Required evidence</th></tr><tr><td>decoy</td><td>Yes</td><td>Yes</td><td>Done</td><td>decoy evidence</td></tr></table>\n</div>\n`
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({
        featureParity: `# Feature parity matrix\n\n${hiddenDoneTable}\n${partialTable}`
      })
    );
    assert.ok(problems.includes('Parity row "CSV/TSV/Parquet/Excel/JSONL entry points" is Partial, not Done.'));
  }

  const tableOnly = parity()
    .split("\n## DuckDB file-backed preview matrix")[0]
    .replace(/^# Feature parity matrix\n\n/u, "");
  const duplicate = inspectStableReleaseReadiness(
    ready({ featureParity: `# Feature parity matrix\n\n${tableOnly}\n${tableOnly}` })
  );
  assert.equal(
    duplicate[0],
    "docs/feature-parity.md must contain exactly one active top-level canonical Pandas/Polars parity table; found 2."
  );

  const wrongSection = inspectStableReleaseReadiness(
    ready({ featureParity: `# Feature parity matrix\n\n## Deferred\n\n${parity()}` })
  );
  assert.ok(
    wrongSection.includes(
      "The canonical Pandas/Polars parity table must remain in the top-level feature-parity section."
    )
  );
});

test("requires substantive completed evidence for every Done parity row", () => {
  for (const evidence of [
    "",
    "TODO",
    "Pending",
    "Add installed-editor timing",
    "Will add tests later; test:scripts/release-readiness.test.mjs",
    "Exact acceptance; test:scripts/missing.test.mjs",
    "Exact acceptance; test:docs/testing.md",
    "Exact acceptance; workflow:docs/testing.md",
    "Exact acceptance; record:scripts/release-readiness.test.mjs",
    "Exact acceptance; test:../scripts/release-readiness.test.mjs",
    "Exact acceptance; test:scripts/release-readiness.test.mjs and test:not tracked",
    "<!-- Exact acceptance passed --> test:scripts/release-readiness.test.mjs",
    "Exact acceptance passed <!-- test:scripts/release-readiness.test.mjs -->"
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE, evidence) })
    );
    assert.ok(
      problems.some(
        (problem) => problem.includes("empty or malformed row") || problem.includes("must record acceptance progress")
      )
    );
  }

  for (const evidence of [
    "Exact script acceptance passed; test:scripts/release-readiness.test.mjs",
    "Exact workflow acceptance passed; workflow:.github/workflows/release.yml",
    "Recorded editor acceptance passed; record:docs/testing.md"
  ]) {
    assert.deepEqual(
      inspectStableReleaseReadiness(ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE, evidence) })),
      []
    );
  }
});

test("binds the primary parity table to the exact ordered release scope", () => {
  const missing = inspectStableReleaseReadiness(
    ready({ featureParity: parity("Done", PRIMARY_PARITY_SCOPE.slice(1)) })
  );
  assert.ok(missing.some((problem) => problem.includes("must contain exactly 31 release rows; found 30")));
  assert.ok(missing.some((problem) => problem.includes('must be "CSV/TSV/Parquet/Excel/JSONL entry points"')));

  const duplicatedScope = [PRIMARY_PARITY_SCOPE[0], PRIMARY_PARITY_SCOPE[0], ...PRIMARY_PARITY_SCOPE.slice(1)];
  const duplicated = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", duplicatedScope) }));
  assert.ok(duplicated.some((problem) => problem.includes("must contain exactly 31 release rows; found 32")));
  assert.ok(
    duplicated.some((problem) => problem.includes('Parity row 2 must be "Notebook variable viewer and toolbar"'))
  );

  const reorderedScope = [PRIMARY_PARITY_SCOPE[1], PRIMARY_PARITY_SCOPE[0], ...PRIMARY_PARITY_SCOPE.slice(2)];
  const reordered = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", reorderedScope) }));
  assert.ok(
    reordered.some((problem) => problem.includes('Parity row 1 must be "CSV/TSV/Parquet/Excel/JSONL entry points"'))
  );
  assert.ok(
    reordered.some((problem) => problem.includes('Parity row 2 must be "Notebook variable viewer and toolbar"'))
  );

  const extraScope = [...PRIMARY_PARITY_SCOPE, ["Unexpected surface", "Yes", "Yes"]];
  const extra = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", extraScope) }));
  assert.ok(extra.some((problem) => problem.includes("must contain exactly 31 release rows; found 32")));
  assert.ok(extra.includes('Unexpected parity row "Unexpected surface" at position 32.'));

  const wrongScope = PRIMARY_PARITY_SCOPE.map((row) => [...row]);
  wrongScope[27] = [wrongScope[27][0], "Yes", "Yes"];
  const wrongEngines = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", wrongScope) }));
  assert.ok(
    wrongEngines.some((problem) =>
      problem.includes('Parity row 28 must be "Duplicate/non-string Pandas column operations" (Yes/N/A)')
    )
  );
});

test("keeps the checked-in parity table aligned with the canonical scope before every release", () => {
  const featureParity = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
  const problems = inspectStableReleaseReadiness(ready({ featureParity }));
  const expectedIncompleteRows = /^Parity row ".+" is (?:Partial|Planned), not Done\.$/u;

  assert.deepEqual(
    problems.filter((problem) => !expectedIncompleteRows.test(problem)),
    []
  );
});

test("binds the release tag, source package, Python runtime, and packaged versions", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      releaseTag: "v1.0.1",
      pythonVersionFile: '__version__ = "1.0.1"\n',
      packagedPackageJson: JSON.stringify({ ...stablePackage, version: "1.0.2" }),
      packagedPythonVersionFile: '__version__ = "1.0.4"\n',
      vsixManifest: manifest({ version: "1.0.3" })
    })
  );

  assert.ok(problems.includes("Release tag v1.0.1 does not match source version v1.0.0."));
  assert.ok(problems.includes("Python runtime version 1.0.1 does not match source package version 1.0.0."));
  assert.ok(problems.includes("Packaged Python runtime version 1.0.4 does not match source package version 1.0.0."));
  assert.ok(problems.includes("Packaged package.json version does not match source package.json."));
  assert.ok(problems.includes("VSIX identity version does not match source package.json version."));
});

test("requires explicit stable channel metadata in source, package, and VSIX", () => {
  const previewProperty = '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />';
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify({ ...stablePackage, preview: true }),
      packagedPackageJson: JSON.stringify({ ...stablePackage, preview: true }),
      vsixManifest: manifest({ properties: previewProperty })
    })
  );

  assert.ok(problems.includes("Source package.json preview must be false for a stable release."));
  assert.ok(problems.includes("Packaged package.json preview must be false for a stable release."));
  assert.ok(problems.includes("Stable packages must not contain Microsoft.VisualStudio.Code.PreRelease."));
});

test("rejects preview-channel numbers in direct stable readiness calls", () => {
  for (const version of ["0.3.0", "1.99.0"]) {
    const previewNumberMarkedStable = { ...stablePackage, version };
    const problems = inspectStableReleaseReadiness(
      ready({
        releaseTag: `v${version}`,
        sourcePackageJson: JSON.stringify(previewNumberMarkedStable),
        pythonVersionFile: `__version__ = "${version}"\n`,
        packagedPackageJson: JSON.stringify(previewNumberMarkedStable),
        packagedPythonVersionFile: `__version__ = "${version}"\n`,
        vsixManifest: manifest({ version })
      })
    );

    assert.ok(
      problems.includes(
        `Source package.json version ${version} is reserved for preview releases and cannot pass stable readiness.`
      )
    );
  }
});

test("requires one real dated changelog heading for the stable version", () => {
  for (const changelog of [
    "# Changelog\n\n## [1.0.0] - Unreleased\n",
    "# Changelog\n\n## [1.0.0] - 2026-02-30\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Added\n\n- <!-- Hidden substantive release note. -->\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Notes\n\n- This decoy is not a release category.\n",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n## [1.0.0] - 2026-07-28\n",
    "# Changelog\n\n```\n## [1.0.0] - 2026-07-27\n```\n",
    "# Changelog\n\n<!--\n## [1.0.0] - 2026-07-27\n-->\n",
    "# Changelog\n\n<div hidden><h2>[1.0.0] - 2026-07-27</h2><h3>Added</h3><ul><li>Hidden decoy change.</li></ul></div>\n"
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ changelog }));
    assert.ok(problems.some((problem) => problem.startsWith("CHANGELOG.md")));
  }
});

test("requires one exact positive stable release and install section in both README copies", () => {
  assert.deepEqual(inspectStableReadme(ready().readme.replace(/\n/gu, "\r\n")), []);
  for (const malformed of [undefined, null, 1, {}, Buffer.from("# Open Wrangler\n")]) {
    assert.notDeepEqual(inspectStableReadme(malformed), []);
  }
  for (const readme of [
    "# Open Wrangler\n\nOpen Wrangler remains preview software.\n",
    "# Open Wrangler\n\nNo packaged releases are available.\n",
    `# Open Wrangler\n\n\`\`\`markdown\n${STABLE_README_RELEASE_SECTION}\n\`\`\`\n`,
    `# Open Wrangler\n\n<!--\n${STABLE_README_RELEASE_SECTION}\n-->\n`,
    `# Open Wrangler\n\n<div hidden>\n${STABLE_README_RELEASE_SECTION}\n</div>\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${STABLE_README_RELEASE_SECTION}\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION.replace("Latest stable:", "Stable:")}\n`
  ]) {
    const problems = inspectStableReleaseReadiness(ready({ readme }));
    assert.ok(problems.some((problem) => problem.startsWith("README.md must")));
  }

  for (const contradiction of [
    "Prebuilt releases are not published.",
    "Future preview builds will appear here.",
    "Open Wrangler itself remains a preview.",
    "This is a preview release for Open Wrangler.",
    "This is not parity-complete for Open Wrangler."
  ]) {
    const problems = inspectStableReleaseReadiness(
      ready({ readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${contradiction}\n` })
    );
    assert.ok(
      problems.includes("README.md contains release-channel status or install material outside its generated region.")
    );
  }

  assert.deepEqual(
    inspectStableReleaseReadiness(
      ready({
        readme: `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\nDuckDB notebook support remains a preview experiment.\n`
      })
    ),
    []
  );

  const packagedProblems = inspectStableReleaseReadiness(
    ready({ packagedReadme: "# Open Wrangler\n\nOpen Wrangler remains preview software.\n" })
  );
  assert.ok(packagedProblems.some((problem) => problem.startsWith("Packaged README must")));
});

test("keeps the checked-in README release and install section generated for its current source channel", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const featureParity = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
  const packageJson = parseStrictJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"), {
    maxBytes: 1024 * 1024
  });
  assert.equal(typeof packageJson?.preview, "boolean");
  if (packageJson.preview === true) {
    assert.deepEqual(inspectPreviewReadme(readme), []);
    assert.deepEqual(inspectPreviewRParitySource({ featureParity }), []);
    assert.ok(readme.includes(PREVIEW_README_RELEASE_SECTION));
    return;
  }

  const trackedEvidencePaths = new Set(
    execFileSync("git", ["ls-files", "-z", "--"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true
    })
      .split("\0")
      .filter(Boolean)
  );
  const stableProblems = inspectStableSourceReadiness({
    featureParity,
    readme,
    trackedEvidencePaths,
    version: packageJson.version
  });
  const evidenceProblems = inspectPerformanceEvidenceSourceReadiness({
    featureParity,
    readme,
    trackedEvidencePaths,
    version: packageJson.version
  });
  assert.equal(Number(stableProblems.length === 0) + Number(evidenceProblems.length === 0), 1);
  if (evidenceProblems.length === 0) {
    assert.deepEqual(inspectPerformanceEvidenceReadme(readme), []);
    assert.ok(readme.includes(PERFORMANCE_EVIDENCE_README_RELEASE_SECTION));
  } else {
    assert.ok(readme.includes(STABLE_README_RELEASE_SECTION));
  }
});

test("keeps the same compact editor support tiers in every README channel", () => {
  for (const section of [
    PREVIEW_README_RELEASE_SECTION,
    PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
    STABLE_README_RELEASE_SECTION
  ]) {
    assert.match(section, /\| VS Code\s+\| Release-tested\s+\|/u);
    assert.match(section, /\| Cursor\s+\| Release-tested\s+\|/u);
    assert.match(section, /\| Other VS Code desktop forks\s+\| Experimental\s+\|/u);
    assert.match(section, /\| Browser-hosted `vscode\.dev`\s+\| Unsupported\s+\|/u);
    assert.doesNotMatch(section, /VS Code and Cursor are release-tested\./u);
    assert.doesNotMatch(section, /Other VS Code desktop forks may work, but support is experimental\./u);
    assert.doesNotMatch(section, /Antigravity|release gate|parity matrix/iu);
  }
  for (const section of [PREVIEW_README_RELEASE_SECTION, STABLE_README_RELEASE_SECTION]) {
    assert.match(section, /Open Wrangler stays inactive in Restricted Mode\./u);
  }
  const stableLinks = new Map(
    [...STABLE_README_RELEASE_SECTION.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)].map((match) => [match[1], match[2]])
  );
  assert.equal(
    stableLinks.get("Visual Studio Marketplace"),
    "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"
  );
  assert.equal(stableLinks.get("Open VSX"), "https://open-vsx.org/extension/Matt17BR/openwrangler");
  assert.equal(
    stableLinks.get("latest stable GitHub Release"),
    "https://github.com/Matt17BR/openwrangler/releases/latest"
  );
  assert.equal(stableLinks.get("GitHub prereleases"), "https://github.com/Matt17BR/openwrangler/releases");
  assert.match(STABLE_README_RELEASE_SECTION, /choose the newest\s+stable version from \[Open VSX\]/u);
  assert.doesNotMatch(STABLE_README_RELEASE_SECTION, /Marketplace\]\([^)]+\) or\s+\[Open VSX\]/u);
});

test("points preview installs at the published prerelease channels", () => {
  const previewLinks = new Map(
    [...PREVIEW_README_RELEASE_SECTION.matchAll(/\[([^\]]+)\]\(([^)]+)\)/gu)].map((match) => [match[1], match[2]])
  );
  assert.equal(
    previewLinks.get("Visual Studio Marketplace"),
    "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler"
  );
  assert.equal(previewLinks.get("Open VSX"), "https://open-vsx.org/extension/Matt17BR/openwrangler");
  assert.equal(
    previewLinks.get("latest stable GitHub Release"),
    "https://github.com/Matt17BR/openwrangler/releases/latest"
  );
  assert.equal(previewLinks.get("GitHub prereleases"), "https://github.com/Matt17BR/openwrangler/releases");
  assert.match(PREVIEW_README_RELEASE_SECTION, /Install Pre-Release Version/u);
  assert.match(PREVIEW_README_RELEASE_SECTION, /newest `1\.99\.x` version/u);
  assert.doesNotMatch(PREVIEW_README_RELEASE_SECTION, /npm install|python3 -m venv/iu);
});

test("documents one bounded current-source build in every public README channel", () => {
  for (const section of [PREVIEW_README_RELEASE_SECTION, STABLE_README_RELEASE_SECTION]) {
    assert.match(section, /\*\*Latest stable:\*\*/u);
    assert.match(section, /\*\*Latest preview:\*\*/u);
    assert.match(section, /\*\*Current `main`:\*\*/u);
    assert.match(section, /git clone https:\/\/github\.com\/Matt17BR\/openwrangler\.git/u);
    assert.match(section, /npm ci\nnpm run package:dev/u);
    assert.match(section, /code --install-extension openwrangler-dev\.vsix --force/u);
    assert.match(section, /cursor --install-extension openwrangler-dev\.vsix --force/u);
    assert.match(section, /may be ahead of the published preview/u);
  }

  const packageJson = parseStrictJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"), {
    maxBytes: 1024 * 1024
  });
  assert.equal(
    packageJson?.scripts?.["package:dev"],
    "npm run clean && npm run build && node scripts/package-current-channel.mjs --out openwrangler-dev.vsix"
  );
});

test("uses linked live badges instead of a prose release status", () => {
  for (const section of [PREVIEW_README_RELEASE_SECTION, STABLE_README_RELEASE_SECTION]) {
    assert.doesNotMatch(section, /Release status/iu);
    for (const expected of [
      "https://img.shields.io/github/v/release/Matt17BR/openwrangler",
      "https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?branch=main",
      "https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg",
      "https://img.shields.io/open-vsx/v/Matt17BR/openwrangler",
      "https://img.shields.io/github/license/Matt17BR/openwrangler"
    ]) {
      assert.ok(section.includes(expected));
    }
  }
});

test("rejects malformed and ambiguous package, Python, and VSIX metadata", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: "{",
      pythonVersionFile: '__version__ = "1.0.0"\n__version__ = "1.0.0"\n',
      packagedPackageJson: "[]",
      packagedPythonVersionFile: "",
      vsixManifest: `<PackageManifest xmlns="${namespace}"><Metadata><Properties /></Metadata></PackageManifest>`
    })
  );

  assert.ok(problems.includes("Source package.json must contain valid bounded JSON."));
  assert.ok(
    problems.includes('python/openwrangler_runtime/version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(
    problems.includes('Packaged Python runtime version.py must contain exactly one __version__ = "..." assignment.')
  );
  assert.ok(problems.includes("Packaged package.json must contain a JSON object."));
  assert.ok(problems.includes("VSIX manifest must contain one canonical Metadata > Identity element."));
});

test("rejects duplicate JSON keys including escaped and nested aliases", () => {
  const duplicateSource = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson:
        '{"name":"wrong","\\u006eame":"openwrangler","displayName":"Open Wrangler","publisher":"Matt17BR","version":"1.0.0","preview":false}'
    })
  );
  assert.ok(duplicateSource.includes("Source package.json must not contain duplicate object keys."));

  const duplicatePackaged = inspectStableReleaseReadiness(
    ready({
      packagedPackageJson:
        '{"name":"openwrangler","displayName":"Open Wrangler","publisher":"Matt17BR","version":"1.0.0","preview":false,"nested":{"value":1,"value":2}}'
    })
  );
  assert.ok(duplicatePackaged.includes("Packaged package.json must not contain duplicate object keys."));
});

test("requires the complete packaged manifest to equal the source manifest", () => {
  const source = { ...stablePackage, main: "./dist/extension/activate.js", engines: { vscode: "^1.106.0" } };
  const packaged = { ...source, main: "./dist/extension/other.js", engines: { vscode: "*" } };
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify(source),
      packagedPackageJson: JSON.stringify(packaged)
    })
  );
  assert.ok(
    problems.includes(
      "Packaged package.json must exactly match source package.json; no packaging transformations are permitted."
    )
  );
});

test("binds the VSIX identity to the extension package identity", () => {
  const problems = inspectStableReleaseReadiness(
    ready({
      vsixManifest: manifest({ id: "other", publisher: "OtherPublisher" })
    })
  );
  assert.ok(problems.includes("VSIX identity ID does not match source package.json name."));
  assert.ok(problems.includes("VSIX identity publisher does not match source package.json publisher."));
});

test("pins the stable source identity even when source, package, and VSIX agree on a rename", () => {
  const renamedPackage = {
    ...stablePackage,
    name: "renamed-wrangler",
    displayName: "Renamed Wrangler",
    publisher: "OtherPublisher"
  };
  const problems = inspectStableReleaseReadiness(
    ready({
      sourcePackageJson: JSON.stringify(renamedPackage),
      packagedPackageJson: JSON.stringify(renamedPackage),
      vsixManifest: manifest({ id: renamedPackage.name, publisher: renamedPackage.publisher })
    })
  );

  assert.ok(problems.includes('Source package.json name must be "openwrangler" for a stable release.'));
  assert.ok(problems.includes('Source package.json displayName must be "Open Wrangler" for a stable release.'));
  assert.ok(problems.includes('Source package.json publisher must be "Matt17BR" for a stable release.'));
});

test("inspects and checksums one owned immutable VSIX snapshot", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-readiness-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);

  const snapshot = readOwnedVsixSnapshot(candidate);
  const original = Buffer.from(snapshot.bytes);
  const expectedDigest = createHash("sha256").update(original).digest("hex");
  assert.equal(snapshot.sha256, expectedDigest);

  writeFileSync(candidate, "replacement bytes that must never be published");
  const payload = await readStableVsixPayload(snapshot.bytes);
  assert.deepEqual(JSON.parse(payload.packagedPackageJson), stablePackage);
  assert.equal(payload.packagedPythonVersionFile, '__version__ = "1.0.0"\n');

  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });
  assert.deepEqual(readFileSync(published), original);
  assert.equal(readFileSync(checksum, "utf8"), `${expectedDigest}  openwrangler.vsix\n`);
  revalidateStableReleaseArtifacts({
    checksumOutput: checksum,
    checksumReceipt: receipts.checksumReceipt,
    snapshot,
    vsixOutput: published,
    vsixReceipt: receipts.vsixReceipt
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(published).mode & 0o222, 0);
    assert.equal(statSync(checksum).mode & 0o222, 0);
  }
});

test("reads release documentation from the exact immutable Git commit", () => {
  const root = resolve(import.meta.dirname, "..");
  const expectedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  const source = readReleaseSourceSnapshot({ expectedCommit, root });
  assert.equal(source.commit, expectedCommit);
  assert.ok(source.trackedPaths.has("docs/testing.md"));
  assert.match(source.files.get("package.json"), /"name": "openwrangler"/u);

  const repository = mkdtempSync(join(tmpdir(), "ow-release-source-commit-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    writeFileSync(join(repository, "marker.txt"), "first\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Open Wrangler Tests",
        "-c",
        "user.email=tests@openwrangler.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "first"
      ],
      { cwd: repository }
    );
    const otherCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8"
    }).trim();
    writeFileSync(join(repository, "marker.txt"), "second\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Open Wrangler Tests",
        "-c",
        "user.email=tests@openwrangler.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "second"
      ],
      { cwd: repository }
    );
    assert.throws(
      () => readReleaseSourceSnapshot({ expectedCommit: otherCommit, root: repository }),
      /exact checked-out event commit/u
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("reads the linked performance report from the immutable release commit", () => {
  const repository = mkdtempSync(join(tmpdir(), "ow-release-performance-source-"));
  try {
    const reportDirectory = join(repository, "docs", "performance", "data-wrangler-2.0.0");
    mkdirSync(join(repository, "python", "openwrangler_runtime"), { recursive: true });
    mkdirSync(join(repository, "docs"), { recursive: true });
    mkdirSync(reportDirectory, { recursive: true });
    writeFileSync(join(repository, "package.json"), JSON.stringify({ ...stablePackage, version: "2.0.0" }));
    writeFileSync(join(repository, "python", "openwrangler_runtime", "version.py"), '__version__ = "2.0.0"\n');
    writeFileSync(join(repository, "docs", "feature-parity.md"), "# Feature parity\n");
    writeFileSync(join(repository, "CHANGELOG.md"), "# Changelog\n");
    writeFileSync(
      join(repository, "README.md"),
      `# Open Wrangler\n\n## Performance\n\n[full benchmark report](https://github.com/Matt17BR/openwrangler/blob/main/docs/performance/data-wrangler-2.0.0/review.md)\n`
    );
    writeFileSync(join(reportDirectory, "review.md"), "# Review\n");
    const reportSource = JSON.stringify({
      provenance: { openWrangler: { version: "2.0.0", sha256: COMPARISON_TEST_SHA } }
    });
    writeFileSync(join(reportDirectory, "report.json"), reportSource);
    execFileSync("git", ["init", "--quiet"], { cwd: repository });
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Open Wrangler Tests",
        "-c",
        "user.email=tests@openwrangler.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "release"
      ],
      { cwd: repository }
    );
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const source = readReleaseSourceSnapshot({ expectedCommit: commit, root: repository });
    assert.equal(source.files.get("docs/performance/data-wrangler-2.0.0/report.json"), reportSource);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("pins a canonical output parent while allowing symlinked ancestry", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-parent-alias-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const firstParent = join(root, "first");
  const secondParent = join(root, "second");
  const alias = join(root, "alias");
  mkdirSync(firstParent, { mode: 0o700 });
  mkdirSync(secondParent, { mode: 0o700 });
  symlinkSync(firstParent, alias, process.platform === "win32" ? "junction" : "dir");

  const candidate = join(root, "candidate.vsix");
  const published = join(alias, "openwrangler.vsix");
  const checksum = join(alias, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });
  assert.deepEqual(readFileSync(join(firstParent, "openwrangler.vsix")), snapshot.bytes);

  unlinkSync(alias);
  symlinkSync(secondParent, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed/u
  );
});

test("revalidates published output content and parent identities", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-output-revalidation-"));
  const movedRoot = `${root}-moved`;
  context.after(() => {
    rmSync(root, { force: true, recursive: true });
    rmSync(movedRoot, { force: true, recursive: true });
  });
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });

  chmodSync(published, 0o600);
  const tampered = Buffer.from(snapshot.bytes);
  tampered[0] ^= 0xff;
  writeFileSync(published, tampered);
  chmodSync(published, 0o444);
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed|content changed|does not match/u
  );

  renameSync(root, movedRoot);
  mkdirSync(root, { mode: 0o700 });
  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /identity or parent changed/u
  );
});

test("rejects mutation of the first output while jointly verifying the second", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-joint-output-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  const published = join(root, "openwrangler.vsix");
  const checksum = join(root, "openwrangler.vsix.sha256");
  await createReleaseVsix(candidate);
  const snapshot = readOwnedVsixSnapshot(candidate);
  const receipts = writeStableReleaseArtifacts({
    checksumOutput: checksum,
    snapshot,
    vsixOutput: published
  });

  assert.throws(
    () =>
      revalidateStableReleaseArtifacts({
        afterVsixRead: () => {
          chmodSync(published, 0o600);
          const tampered = Buffer.from(snapshot.bytes);
          tampered[tampered.length - 1] ^= 0xff;
          writeFileSync(published, tampered);
          chmodSync(published, 0o444);
        },
        checksumOutput: checksum,
        checksumReceipt: receipts.checksumReceipt,
        snapshot,
        vsixOutput: published,
        vsixReceipt: receipts.vsixReceipt
      }),
    /joint final identity/u
  );
});

test("strictly streams and validates the complete shared VSIX inventory", async () => {
  const valid = await createReleaseVsixBuffer();
  const payload = await inspectVsixArchive(valid);
  assert.equal(payload.archiveEntries.length, releaseVsixEntries().size);
  assert.deepEqual(JSON.parse(payload.packagedPackageJson), stablePackage);
  assert.equal(payload.packagedReadme, `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`);
  assert.equal(payload.packagedChangelog, "# Changelog\n");
  assert.equal(payload.packagedLicense, "MIT License\n");
  assert.equal(payload.packagedThirdPartyNotices, "# Third-party notices\n");
  assert.equal(new Map(payload.entrySizes).get(VENDORED_JS_YAML_ENTRY), VENDORED_JS_YAML_BYTES);
  assert.equal(new Map(payload.entryDigests).get(VENDORED_JS_YAML_ENTRY), VENDORED_JS_YAML_SHA256);

  const packageWithoutR = await inspectVsixArchive(
    await createReleaseVsixBuffer({ omitted: new Set(rRuntimeEntries) }),
    { requireRFrameContract: false }
  );
  assert.equal(new Map(packageWithoutR.entryDigests).get(VENDORED_JS_YAML_ENTRY), VENDORED_JS_YAML_SHA256);
  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({ omitted: new Set([...rRuntimeEntries, VENDORED_JS_YAML_ENTRY]) }),
      { requireRFrameContract: false }
    ),
    /Missing: extension\/dist\/extension\/vendor\/js-yaml\.js/u
  );

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        omitted: new Set(["extension/LICENSE.txt"])
      })
    ),
    /Missing: extension\/LICENSE\.txt/u
  );

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        omitted: new Set([VENDORED_JS_YAML_ENTRY])
      })
    ),
    /Missing: extension\/dist\/extension\/vendor\/js-yaml\.js/u
  );

  const mutatedVendorEntries = releaseVsixEntries();
  const mutatedVendor = Buffer.from(vendoredJsYaml);
  const asciiMutation = mutatedVendor.indexOf(Buffer.from("function"));
  assert.notEqual(asciiMutation, -1);
  mutatedVendor[asciiMutation] = "g".charCodeAt(0);
  mutatedVendorEntries.set(VENDORED_JS_YAML_ENTRY, mutatedVendor);
  await assert.rejects(
    inspectVsixArchive(await createReleaseVsixBuffer({ entries: mutatedVendorEntries })),
    /vendored js-yaml runtime must match its exact reviewed size and SHA-256 receipt/u
  );
  await assert.rejects(
    inspectVsixArchive(await createReleaseVsixBuffer({ entries: mutatedVendorEntries }), {
      requireVendoredJsYaml: false
    }),
    /vendored js-yaml runtime must match its exact reviewed size and SHA-256 receipt/u
  );

  const unexpectedVendorEntries = releaseVsixEntries();
  unexpectedVendorEntries.set("extension/dist/extension/vendor/unreviewed.js", "export {};");
  await assert.rejects(
    inspectVsixArchive(await createReleaseVsixBuffer({ entries: unexpectedVendorEntries })),
    /Forbidden: extension\/dist\/extension\/vendor\/unreviewed\.js/u
  );

  for (const mixedCaseVendor of [
    "extension/dist/extension/VENDOR/unreviewed.js",
    "extension/dist/extension/VeNdOr/js-yaml.js",
    "extension/dist/extension/nested/vEnDoR/unreviewed.js"
  ]) {
    const mixedCaseVendorEntries = releaseVsixEntries();
    mixedCaseVendorEntries.set(mixedCaseVendor, "export {};");
    await assert.rejects(
      inspectVsixArchive(await createReleaseVsixBuffer({ entries: mixedCaseVendorEntries })),
      new RegExp(`Forbidden: ${mixedCaseVendor.replaceAll(".", "\\.")}`, "u")
    );
  }

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        entryModes: new Map([["extension/media/icon.png", 0o120777]])
      })
    ),
    /must be a regular file or matching directory entry/u
  );

  await assert.rejects(
    inspectVsixArchive(
      await createReleaseVsixBuffer({
        entries: releaseVsixEntries({
          ...stablePackage,
          icon: "media/missing.png"
        })
      })
    ),
    /references missing regular asset extension\/media\/missing\.png/u
  );

  const oversizedEntries = releaseVsixEntries();
  oversizedEntries.set("extension/media/webview.js", Buffer.alloc(MAX_VSIX_ENTRY_BYTES + 1));
  await assert.rejects(
    inspectVsixArchive(await createReleaseVsixBuffer({ entries: oversizedEntries })),
    /exceeds its per-entry size limit/u
  );

  const encrypted = patchZipEntry(valid, "extension/media/icon.png", ({ centralOffset, localOffset, result }) => {
    result.writeUInt16LE(result.readUInt16LE(centralOffset + 8) | 0x0001, centralOffset + 8);
    result.writeUInt16LE(result.readUInt16LE(localOffset + 6) | 0x0001, localOffset + 6);
  });
  await assert.rejects(inspectVsixArchive(encrypted), /uses unsupported or encrypted ZIP flags/u);

  const wrongCrc = patchZipEntry(valid, "extension/media/icon.png", ({ centralOffset, result }) => {
    result.writeUInt32LE((result.readUInt32LE(centralOffset + 16) ^ 0xffffffff) >>> 0, centralOffset + 16);
  });
  await assert.rejects(inspectVsixArchive(wrongCrc), /failed CRC-32 validation/u);
});

test("verify-vsix rejects each shipped-document source mismatch end to end", async (context) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "ow-verify-vsix-documents-"));
  context.after(() => rmSync(temporaryRoot, { force: true, recursive: true }));

  const sourcePackage = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
  const baseEntries = releaseVsixEntries(sourcePackage);
  baseEntries.set(
    "extension.vsixmanifest",
    manifest({
      version: sourcePackage.version,
      properties: sourcePackage.preview ? '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />' : ""
    })
  );
  for (const [source, archive] of [
    ["README.md", "extension/readme.md"],
    ["CHANGELOG.md", "extension/changelog.md"],
    ["LICENSE", "extension/LICENSE.txt"],
    ["THIRD_PARTY_NOTICES.md", "extension/THIRD_PARTY_NOTICES.md"]
  ]) {
    baseEntries.set(archive, readFileSync(resolve(repositoryRoot, source)));
  }

  const verifier = resolve(repositoryRoot, "scripts", "verify-vsix.mjs");
  const validPath = join(temporaryRoot, "valid.vsix");
  writeFileSync(validPath, await createReleaseVsixBuffer({ entries: baseEntries }), { flag: "wx", mode: 0o600 });
  const validResult = spawnSync(process.execPath, [verifier, validPath], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(validResult.status, 0, validResult.stderr);

  for (const [archive, source] of [
    ["extension/readme.md", "README.md"],
    ["extension/changelog.md", "CHANGELOG.md"],
    ["extension/LICENSE.txt", "LICENSE"],
    ["extension/THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"]
  ]) {
    const driftedEntries = new Map(baseEntries);
    driftedEntries.set(archive, Buffer.concat([driftedEntries.get(archive), Buffer.from("drift")]));
    const candidate = join(temporaryRoot, `${source.replaceAll("/", "-")}.vsix`);
    writeFileSync(candidate, await createReleaseVsixBuffer({ entries: driftedEntries }), {
      flag: "wx",
      mode: 0o600
    });
    const result = spawnSync(process.execPath, [verifier, candidate], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.notEqual(result.status, 0, `${source} drift unexpectedly passed verify-vsix.`);
    assert.match(result.stderr, new RegExp(`Packaged ${archive.replaceAll(".", "\\.")} must exactly match`));
  }
});

test("rejects symlinked and hard-linked stable VSIX candidates", async (context) => {
  const root = mkdtempSync(join(tmpdir(), "ow-release-alias-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  const candidate = join(root, "candidate.vsix");
  await createReleaseVsix(candidate);

  const hardLink = join(root, "candidate-hardlink.vsix");
  linkSync(candidate, hardLink);
  assert.throws(() => readOwnedVsixSnapshot(candidate), /one regular, unlinked file/u);

  if (process.platform !== "win32") {
    const symlink = join(root, "candidate-symlink.vsix");
    symlinkSync(candidate, symlink);
    assert.throws(() => readOwnedVsixSnapshot(symlink), /one regular, unlinked file/u);
  }
});

test("structurally gates the candidate-first preview workflow and exact artifact triple", () => {
  const workflowSource = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.deepEqual(inspectReleaseWorkflow(workflowSource), []);

  const mutate = (change) => {
    const workflow = parseYaml(workflowSource);
    change(workflow);
    return inspectReleaseWorkflow(dumpYaml(workflow));
  };
  const cases = [
    (workflow) => {
      workflow.on.workflow_dispatch.inputs.publish.default = true;
    },
    (workflow) => {
      delete workflow.jobs["candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].uses = "./.github/workflows/other.yml";
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy["fail-fast"] = true;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy["max-parallel"] = 1;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.exclude = [{ lane: "jupyter" }];
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.experimental = [false];
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.include.pop();
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@")).uses =
        "actions/checkout@v6";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.name === "Require protected main source").run = [
        '# test "$EVENT_REF_TYPE" = "branch"',
        '# test "$EVENT_REF" = "refs/heads/main"',
        '# case "$EXPECTED_SHA" in *[!0-9a-f]*|"") exit 1 ;; esac',
        '# test "${#EXPECTED_SHA}" -eq 40'
      ].join("\n");
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.name === "Require exact protected main commit").run = [
        '# test "$(git rev-parse --verify HEAD^{commit})" = "$EXPECTED_SHA"',
        '# test -z "$(git status --porcelain --untracked-files=no)"',
        '# test "$(git rev-parse --verify refs/remotes/origin/main^{commit})" = "$EXPECTED_SHA"'
      ].join("\n");
    },
    (workflow) => {
      const packageSteps = workflow.jobs.package.steps;
      const metadataIndex = packageSteps.findIndex((step) => step.id === "release_metadata");
      const [metadata] = packageSteps.splice(metadataIndex, 1);
      packageSteps.push(metadata);
    },
    (workflow) => {
      const upload = workflow.jobs.package.steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/upload-artifact@")
      );
      upload.with.path = upload.with.path.replace("canonical-release/openwrangler.vsix.provenance.json\n", "");
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.id === "canonical").run =
        "node scripts/verify-canonical-release-artifact.mjs canonical-release";
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].with.channel = "stable";
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].with.artifact_id = "openwrangler-preview-release";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].needs = ["package", "candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.find((step) =>
        String(step.run ?? "").includes("npm run test:remote-workspace --")
      ).run = "echo skipped";
    },
    (workflow) => {
      workflow.jobs.release.needs = ["package", "candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs.release.needs = ["package", "remote-ssh"];
    },
    (workflow) => {
      workflow.jobs.release.needs = ["candidate-acceptance", "remote-ssh"];
    },
    (workflow) => {
      workflow.jobs.release.if = "${{ inputs.publish != false }}";
    },
    (workflow) => {
      workflow.jobs.release.environment = "unprotected";
    },
    (workflow) => {
      workflow.jobs.release.concurrency.queue = "latest";
    },
    (workflow) => {
      workflow.jobs.release.steps.find(
        (step) => step.env?.GITHUB_IMMUTABLE_RELEASES_EXPECTED
      ).env.GITHUB_IMMUTABLE_RELEASES_EXPECTED = "false";
    },
    (workflow) => {
      const releaseSteps = workflow.jobs.release.steps;
      const tagIndex = releaseSteps.findIndex((step) => step.run === "node scripts/push-release-tag.mjs");
      const [tag] = releaseSteps.splice(tagIndex, 1);
      releaseSteps.push(tag);
    },
    (workflow) => {
      workflow.jobs.release.steps.find(
        (step) => step.name === "Prepare the exact local release tag for registry verification"
      ).run = "node scripts/prepare-stable-candidate-tag.mjs --require-remote";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => String(step.run ?? "").includes("ovsx verify-pat")).run =
        "npx --no-install ovsx verify-pat Matt17BR";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => String(step.run ?? "").includes("ovsx verify-pat")).run =
        "echo ovsx verify-pat Matt17BR";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => String(step.run ?? "").includes("ovsx publish")).env.RELEASE_VERSION =
        "1.99.0";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => String(step.run ?? "").includes("ovsx publish")).run =
        "echo ovsx publish --skip-duplicate canonical-release/openwrangler.vsix";
    },
    (workflow) => {
      workflow.jobs.release.steps.find(
        (step) => step.name === "Reverify the preview before Open VSX publication"
      ).name = "Reverify some preview artifact";
    },
    (workflow) => {
      workflow.jobs.release.steps.find(
        (step) => step.run === "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify"
      ).run = "echo published";
    },
    (workflow) => {
      const releaseSteps = workflow.jobs.release.steps;
      releaseSteps.splice(
        releaseSteps.findIndex((step) => step.id === "public_media_contract"),
        1
      );
    },
    (workflow) => {
      const releaseSteps = workflow.jobs.release.steps;
      const selectorIndex = releaseSteps.findIndex((step) => step.id === "public_media_contract");
      const [selector] = releaseSteps.splice(selectorIndex, 1);
      releaseSteps.push(selector);
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) =>
        String(step.run ?? "").includes("verify-public-media-surfaces.mjs")
      ).if = "always()";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => String(step.run ?? "").includes("--prepublish")).run =
        "echo media preflight skipped";
    },
    (workflow) => {
      const packageSteps = workflow.jobs.package.steps;
      const preflightIndex = packageSteps.findIndex((step) => String(step.run ?? "").includes("--prepublish"));
      const [preflight] = packageSteps.splice(preflightIndex, 1);
      packageSteps.push(preflight);
    },
    (workflow) => {
      workflow.jobs.release.steps.push({
        name: "Unrelated Open VSX token consumer",
        env: { OVSX_PAT: "${{ secrets.OVSX_PAT }}" },
        run: "echo unrelated"
      });
    },
    (workflow) => {
      workflow.jobs.package.environment = "publishing";
    },
    (workflow) => {
      workflow.jobs.package.permissions = { contents: "write" };
    }
  ];

  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(mutate(change), [], `preview workflow mutation ${index + 1} must fail closed`);
  }
});
