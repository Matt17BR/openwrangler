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
import { inspectVsixArchive, MAX_VSIX_ENTRY_BYTES } from "./vsix-archive.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import {
  inspectPreviewReleaseMetadata,
  inspectReleaseMetadata,
  inspectWorkflowReleaseMetadata,
  releaseSourcePolicyForVersion
} from "./release-metadata.mjs";
import { inspectPreviewReleaseWorkflow as inspectReleaseWorkflow } from "./preview-release-workflow.mjs";
import {
  inspectPerformanceEvidenceReadme,
  inspectPreviewReadme,
  PREVIEW_README_RELEASE_SECTION
} from "./release-documents.mjs";
import {
  inspectPerformanceEvidenceCandidateReadiness,
  inspectPerformanceEvidenceSourceReadiness,
  inspectStableReleaseReadiness,
  inspectStableSourceReadiness,
  PERFORMANCE_EVIDENCE_README_RELEASE_SECTION,
  PERFORMANCE_EVIDENCE_PARTIAL_ROWS,
  PERFORMANCE_EVIDENCE_VERSION,
  PRIMARY_PARITY_SCOPE,
  readOwnedVsixSnapshot,
  readReleaseSourceSnapshot,
  readStableVsixPayload,
  revalidateStableReleaseArtifacts,
  STABLE_README_RELEASE_SECTION,
  writeStableReleaseArtifacts
} from "./release-readiness.mjs";

const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const repositoryRoot = resolve(import.meta.dirname, "..");
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
    ["extension/dist/extension/activate.js", "export {};"],
    ["extension/dist/extension/webviewPanel.js", "const policy = `font-src ${webview.cspSource};`;"],
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
      trackedEvidencePaths: ready().trackedEvidencePaths
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

test("binds v1 maintenance and v2 development to distinct protected branches", () => {
  for (const version of ["1.0.0", "1.2.1", "1.98.999", "1.100.0"]) {
    assert.deepEqual(releaseSourcePolicyForVersion(version), {
      branch: "release/1.x",
      ref: "refs/heads/release/1.x",
      version
    });
  }
  for (const version of ["0.3.0", "0.4.0", "1.99.0", "1.99.999", "2.0.0", "3.4.5"]) {
    assert.deepEqual(releaseSourcePolicyForVersion(version), {
      branch: "main",
      ref: "refs/heads/main",
      version
    });
  }
  for (const version of [undefined, "1", "01.2.3", "1.2.3-beta.1"]) {
    assert.equal(releaseSourcePolicyForVersion(version), undefined);
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
  assert.ok(missing.some((problem) => problem.includes("must contain exactly 30 release rows; found 29")));
  assert.ok(missing.some((problem) => problem.includes('must be "CSV/TSV/Parquet/Excel/JSONL entry points"')));

  const duplicatedScope = [PRIMARY_PARITY_SCOPE[0], PRIMARY_PARITY_SCOPE[0], ...PRIMARY_PARITY_SCOPE.slice(1)];
  const duplicated = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", duplicatedScope) }));
  assert.ok(duplicated.some((problem) => problem.includes("must contain exactly 30 release rows; found 31")));
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
  assert.ok(extra.some((problem) => problem.includes("must contain exactly 30 release rows; found 31")));
  assert.ok(extra.includes('Unexpected parity row "Unexpected surface" at position 31.'));

  const wrongScope = PRIMARY_PARITY_SCOPE.map((row) => [...row]);
  wrongScope[26] = [wrongScope[26][0], "Yes", "Yes"];
  const wrongEngines = inspectStableReleaseReadiness(ready({ featureParity: parity("Done", wrongScope) }));
  assert.ok(
    wrongEngines.some((problem) =>
      problem.includes('Parity row 27 must be "Duplicate/non-string Pandas column operations" (Yes/N/A)')
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
  for (const readme of [
    "# Open Wrangler\n\nOpen Wrangler remains preview software.\n",
    "# Open Wrangler\n\nNo packaged releases are available.\n",
    `# Open Wrangler\n\n\`\`\`markdown\n${STABLE_README_RELEASE_SECTION}\n\`\`\`\n`,
    `# Open Wrangler\n\n<!--\n${STABLE_README_RELEASE_SECTION}\n-->\n`,
    `# Open Wrangler\n\n<div hidden>\n${STABLE_README_RELEASE_SECTION}\n</div>\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n\n${STABLE_README_RELEASE_SECTION}\n`,
    `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION.replace("checksummed GitHub Release", "GitHub Release")}\n`
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
  const packageJson = parseStrictJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"), {
    maxBytes: 1024 * 1024
  });
  assert.equal(typeof packageJson?.preview, "boolean");
  if (packageJson.preview === true) {
    assert.deepEqual(inspectPreviewReadme(readme), []);
    assert.ok(readme.includes(PREVIEW_README_RELEASE_SECTION));
    return;
  }

  const featureParity = readFileSync(new URL("../docs/feature-parity.md", import.meta.url), "utf8");
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
    trackedEvidencePaths
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
  assert.equal(stableLinks.get("checksummed GitHub Release"), "https://github.com/Matt17BR/openwrangler/releases");
});

test("uses linked live badges instead of a prose stable status", () => {
  assert.doesNotMatch(STABLE_README_RELEASE_SECTION, /Release status/iu);
  for (const expected of [
    "https://img.shields.io/github/v/release/Matt17BR/openwrangler",
    "https://github.com/Matt17BR/openwrangler/actions/workflows/ci.yml/badge.svg?branch=main",
    "https://vsmarketplacebadges.dev/version-short/Matt17BR.openwrangler.svg",
    "https://img.shields.io/open-vsx/v/Matt17BR/openwrangler",
    "https://img.shields.io/github/license/Matt17BR/openwrangler"
  ]) {
    assert.ok(STABLE_README_RELEASE_SECTION.includes(expected));
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
  baseEntries.set("extension.vsixmanifest", manifest({ version: sourcePackage.version }));
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
      delete workflow.jobs["released-jupyter"];
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
      workflow.jobs["cross-platform"].needs = "linux-acceptance";
    },
    (workflow) => {
      workflow.jobs["cross-platform"].steps.push(
        { run: "npm run check" },
        { run: "npm run test:scripts" },
        { run: "npm run test:webview-acceptance" },
        { run: "npm run test:coverage" },
        { run: "npm audit --omit=dev" },
        { run: "npm run audit:python" },
        { run: "npm run benchmark:runtime" }
      );
    },
    (workflow) => {
      workflow.jobs["linux-acceptance"].steps.find((step) => step.run === "npm run test:coverage").run =
        "npm run test:coverage:partial";
    },
    (workflow) => {
      workflow.jobs["cross-platform"].steps.push({ run: "python -m pytest python/tests -q" });
    },
    (workflow) => {
      workflow.jobs["installed-performance"].steps.find((step) =>
        String(step.run ?? "").includes("benchmark:installed --")
      ).run = "echo skipped";
    },
    (workflow) => {
      workflow.jobs["released-jupyter"].steps.find(
        (step) => step.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER === "1"
      ).env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER = "0";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.find((step) =>
        String(step.run ?? "").includes("npm run test:remote-workspace --")
      ).run = "echo skipped";
    },
    (workflow) => {
      workflow.jobs["acceptance-gate"].steps[0].run = 'test "$PACKAGE_RESULT" = "success"';
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
      workflow.jobs["promote-open-vsx"].uses = "./.github/workflows/unreviewed.yml";
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
