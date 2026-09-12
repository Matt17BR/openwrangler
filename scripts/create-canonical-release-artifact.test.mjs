import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZipFile } from "yazl";
import {
  CANONICAL_RELEASE_PUBLICATION_MODE,
  CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
  CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
  PREVIEW_RELEASE_PUBLICATION_MODE,
  createCanonicalReleaseArtifact,
  createCanonicalReleaseDependencies,
  parseCanonicalReleaseArtifactArguments,
  validateCanonicalReleaseProvenance,
  validatePreviewReleaseProvenance
} from "./create-canonical-release-artifact.mjs";
import { inspectReleaseDocumentationSource, PRIMARY_PARITY_SCOPE } from "./release-readiness.mjs";
import { inspectPrimaryParityMatrix } from "./release-documents.mjs";
import {
  assertReproducibleVsixArchive as assertReproducibleArchive,
  canonicalizeVsixArchive
} from "./reproducible-vsix.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import { verifyCanonicalReleaseArtifact } from "./verify-canonical-release-artifact.mjs";
import { inspectVsixArchive } from "./vsix-archive.mjs";

const readmeCopy = "## Install\n\nCompile and install the current source. Historical preview: v1.99.7.";
const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const vendoredJsYaml = readFileSync(new URL("../node_modules/js-yaml/dist/js-yaml.cjs.js", import.meta.url));
const stablePackage = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR",
  version: "1.0.0",
  preview: false
});
const previewPackage = Object.freeze({
  ...stablePackage,
  version: "0.3.0",
  preview: true
});
const posixTest = process.platform === "win32" ? test.skip : test;

test("canonical artifact CLI permits preview and stable authoring but refuses retired evidence authoring", () => {
  assert.deepEqual(parseCanonicalReleaseArtifactArguments(["candidate.vsix", "--out-dir", "release"]), {
    candidatePath: "candidate.vsix",
    outputDirectory: "release",
    publicationMode: CANONICAL_RELEASE_PUBLICATION_MODE
  });
  assert.deepEqual(
    parseCanonicalReleaseArtifactArguments(["candidate.vsix", "--out-dir", "preview", "--preview-release"]),
    {
      candidatePath: "candidate.vsix",
      outputDirectory: "preview",
      publicationMode: PREVIEW_RELEASE_PUBLICATION_MODE
    }
  );
  for (const malformed of [
    [],
    ["candidate.vsix", "--out-dir", "evidence", "--performance-evidence"],
    ["candidate.vsix", "--performance-evidence", "--out-dir", "evidence"],
    ["candidate.vsix", "--out-dir", "evidence", "--performance-evidence", "--performance-evidence"],
    ["candidate.vsix", "--out-dir", "evidence", "--unknown"]
  ]) {
    assert.throws(
      () => parseCanonicalReleaseArtifactArguments(malformed),
      /prebuilt candidate and a new output directory/u
    );
  }
});

function runGit(root, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  }).trim();
}

function vsixManifest(manifest = stablePackage) {
  const preReleaseProperty = manifest.preview
    ? '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />'
    : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="${namespace}">
  <Metadata>
    <Identity Id="openwrangler" Publisher="Matt17BR" Version="${manifest.version}" />
    <Properties>${preReleaseProperty}</Properties>
  </Metadata>
</PackageManifest>`;
}

function parityMatrix(statuses = new Map()) {
  const rows = PRIMARY_PARITY_SCOPE.map(
    ([surface, pandas, polars]) =>
      `| ${surface} | ${pandas} | ${polars} | ${statuses.get(surface) ?? "Done"} | Exact canonical artifact accepted; test:scripts/evidence.test.mjs |`
  ).join("\n");
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

function nativeRPreviewDisclosure() {
  return `## Native R preview

R notebook viewing, cleaning and export are Preview while exact-candidate qualification is pending.
`;
}

function releaseEntries(readmeSection = readmeCopy, manifest = stablePackage) {
  return new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    ["extension.vsixmanifest", vsixManifest(manifest)],
    ["extension/package.json", JSON.stringify(manifest)],
    ["extension/LICENSE.txt", "MIT License\n"],
    ["extension/readme.md", `# Open Wrangler\n\n${readmeSection}\n`],
    ["extension/changelog.md", "# Changelog\n"],
    ["extension/THIRD_PARTY_NOTICES.md", "# Third-party notices\n"],
    ["extension/dist/extension/activate.js", 'const policy = `font-src ${webview.cspSource};`; require("vscode");'],
    ["extension/dist/extension/vendor/js-yaml.js", vendoredJsYaml],
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
    ["extension/r/openwrangler_runtime/kernel_exports.R", "openwrangler_kernel_exports <- list()\n"],
    ["extension/r/openwrangler_runtime/process_agent.R", 'quit(save = "no")\n'],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/dependency_integrity.py", "pass\n"],
    ["extension/python/openwrangler_runtime/trusted_pickle_to_parquet.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", `__version__ = "${manifest.version}"\n`]
  ]);
}

function createLegacyVsixBuffer(readmeSection = readmeCopy, manifest = stablePackage) {
  const zip = new ZipFile();
  for (const [name, value] of releaseEntries(readmeSection, manifest)) {
    zip.addBuffer(Buffer.from(value), name, { compress: true, forceDosTimestamp: true });
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

async function createVsixBuffer(readmeSection = readmeCopy, manifest = stablePackage) {
  const legacyBytes = await createLegacyVsixBuffer(readmeSection, manifest);
  return (await canonicalizeVsixArchive(legacyBytes)).bytes;
}

function writeSourceFile(root, path, contents) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

async function createFixture(
  context,
  {
    manifest = stablePackage,
    parityStatuses = new Map(),
    featureParity = parityMatrix(parityStatuses),
    readmeSection = readmeCopy,
    tag = true,
    useLegacyVsix = false
  } = {}
) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-canonical-artifact-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "canonical@example.invalid"]);
  runGit(root, ["config", "user.name", "Canonical Artifact Test"]);
  writeSourceFile(root, "package.json", `${JSON.stringify(manifest, null, 2)}\n`);
  writeSourceFile(root, "python/openwrangler_runtime/version.py", `__version__ = "${manifest.version}"\n`);
  writeSourceFile(root, "docs/feature-parity.md", featureParity);
  writeSourceFile(
    root,
    "CHANGELOG.md",
    `# Changelog\n\n## [${manifest.version}] - 2026-07-27\n\n### Added\n\n- Published the verified package.\n`
  );
  writeSourceFile(root, "README.md", `# Open Wrangler\n\n${readmeSection}\n`);
  writeSourceFile(root, "scripts/evidence.test.mjs", "export {};\n");
  const candidateBytes = useLegacyVsix
    ? await createLegacyVsixBuffer(readmeSection, manifest)
    : await createVsixBuffer(readmeSection, manifest);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "release fixture"]);
  const expectedCommit = runGit(root, ["rev-parse", "HEAD"]);
  if (tag) {
    runGit(root, ["tag", `v${manifest.version}`]);
  }
  const candidatePath = join(root, "openwrangler.candidate.vsix");
  writeFileSync(candidatePath, candidateBytes, { flag: "wx", mode: 0o600 });
  return {
    candidateBytes,
    candidatePath,
    expectedCommit,
    outputDirectory: join(root, "canonical-release"),
    releaseTag: `v${manifest.version}`,
    root
  };
}

function packageDependencies() {
  const state = {
    callOrder: [],
    inventoryChecks: 0,
    pins: 0,
    reproducibleChecks: 0,
    sourceComparisons: 0
  };
  const receipt = Object.freeze({ protocol: "test-package-source-v1" });
  return {
    dependencies: {
      assertPackageInventory(_source, entries, digests) {
        state.callOrder.push("assertPackageInventory");
        assert.equal(_source, receipt);
        assert.ok(entries.includes("extension/package.json"));
        assert.ok(digests.some(([name]) => name === "extension/package.json"));
        state.inventoryChecks += 1;
      },
      async assertReproducibleVsixArchive(bytes) {
        state.callOrder.push("assertReproducibleVsixArchive");
        state.reproducibleChecks += 1;
        return await assertReproducibleArchive(bytes);
      },
      assertSamePackageSources(expected, actual) {
        state.callOrder.push("assertSamePackageSources");
        assert.equal(expected, receipt);
        assert.equal(actual, receipt);
        state.sourceComparisons += 1;
      },
      async pinPackageSources() {
        state.callOrder.push("pinPackageSources");
        state.pins += 1;
        return receipt;
      }
    },
    state
  };
}

function artifactOptions(fixture, overrides = {}) {
  const packages = packageDependencies();
  return {
    options: {
      ...fixture,
      dependencies: packages.dependencies,
      ...overrides
    },
    state: packages.state
  };
}

async function createStableV2Fixture(context) {
  const version = "2.0.0";
  const manifest = { ...stablePackage, version };
  return await createFixture(context, {
    featureParity: `${parityMatrix()}\n${nativeRPreviewDisclosure()}`,
    manifest
  });
}

function packageFileForArchiveEntry(entry) {
  if (entry === "extension/readme.md") return "README.md";
  if (entry === "extension/changelog.md") return "CHANGELOG.md";
  if (entry === "extension/LICENSE.txt") return "LICENSE.txt";
  return entry.slice("extension/".length);
}

function archiveEntryForPackageFile(file) {
  const lower = file.toLowerCase();
  if (lower === "readme.md") return "extension/readme.md";
  if (lower === "changelog.md") return "extension/changelog.md";
  if (lower === "license" || lower === "license.txt" || lower === "license.md") return "extension/LICENSE.txt";
  return `extension/${file}`;
}

function realPackageDependencies() {
  const packageEntries = [...releaseEntries()].filter(
    ([entry]) => entry !== "[Content_Types].xml" && entry !== "extension.vsixmanifest"
  );
  const packageFiles = packageEntries.map(([entry]) => packageFileForArchiveEntry(entry));
  const byArchiveEntry = new Map(packageEntries.map(([entry, contents]) => [entry, Buffer.from(contents)]));
  return createCanonicalReleaseDependencies({
    packageSourceOptions: {
      listPackageFiles: async () => packageFiles,
      readTrackedFiles: () => packageFiles,
      deriveGeneratedFiles: () => new Set(),
      pinTrackedFile(file) {
        const archiveEntry = archiveEntryForPackageFile(file);
        const bytes = byArchiveEntry.get(archiveEntry);
        const size = bytes.length;
        return Object.freeze({
          path: file,
          archiveEntry,
          bytes: size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          fileIdentity: Object.freeze({
            dev: 1n,
            ino: BigInt(packageFiles.indexOf(file) + 1),
            size: BigInt(size),
            mtimeNs: 2n,
            ctimeNs: 3n
          })
        });
      }
    }
  });
}

test("atomically publishes exactly one source-bound stable artifact triple", async (context) => {
  const fixture = await createFixture(context);
  const { options, state } = artifactOptions(fixture);
  const receipt = await createCanonicalReleaseArtifact(options);

  assert.equal(receipt.directory, fixture.outputDirectory);
  assert.equal(receipt.publicationMode, CANONICAL_RELEASE_PUBLICATION_MODE);
  assert.equal(receipt.releaseTag, "v1.0.0");
  assert.equal(receipt.sourceCommit, fixture.expectedCommit);
  assert.equal(receipt.files.length, 3);
  assert.deepEqual(readdirSync(fixture.outputDirectory).sort(), [
    "openwrangler.vsix",
    "openwrangler.vsix.provenance.json",
    "openwrangler.vsix.sha256"
  ]);
  assert.deepEqual(readFileSync(join(fixture.outputDirectory, "openwrangler.vsix")), fixture.candidateBytes);
  const digest = createHash("sha256").update(fixture.candidateBytes).digest("hex");
  assert.equal(
    readFileSync(join(fixture.outputDirectory, "openwrangler.vsix.sha256"), "utf8"),
    `${digest}  openwrangler.vsix\n`
  );
  const provenance = validateCanonicalReleaseProvenance(
    parseStrictJson(readFileSync(join(fixture.outputDirectory, "openwrangler.vsix.provenance.json"), "utf8"))
  );
  assert.deepEqual(provenance, {
    protocol: CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "1.0.0",
    preview: false,
    releaseTag: "v1.0.0",
    sourceCommit: fixture.expectedCommit,
    vsixSha256: digest,
    vsixBytes: fixture.candidateBytes.length
  });
  assert.equal(state.inventoryChecks, 1);
  assert.equal(state.pins, 2);
  assert.equal(state.reproducibleChecks, 1);
  assert.equal(state.sourceComparisons, 1);
  assert.deepEqual(state.callOrder, [
    "pinPackageSources",
    "assertReproducibleVsixArchive",
    "assertPackageInventory",
    "pinPackageSources",
    "assertSamePackageSources"
  ]);
  assert.deepEqual(readFileSync(fixture.candidatePath), fixture.candidateBytes);
  assert.equal(
    readdirSync(fixture.root).some((name) => name.startsWith(".canonical-release.tmp-")),
    false
  );
});

test("publishes exact stable 2.x bytes with Native R retained as preview", async (context) => {
  const fixture = await createStableV2Fixture(context);
  const receipt = await createCanonicalReleaseArtifact(artifactOptions(fixture).options);
  const digest = createHash("sha256").update(fixture.candidateBytes).digest("hex");

  assert.equal(receipt.releaseTag, "v2.0.0");
  assert.equal(receipt.sourceCommit, fixture.expectedCommit);
  assert.ok(readFileSync(join(fixture.root, "docs/feature-parity.md"), "utf8").endsWith(nativeRPreviewDisclosure()));
  assert.equal(runGit(fixture.root, ["ls-files", "docs/performance"]), "");
  assert.deepEqual(readFileSync(join(fixture.outputDirectory, "openwrangler.vsix")), fixture.candidateBytes);
  assert.equal(
    readFileSync(join(fixture.outputDirectory, "openwrangler.vsix.sha256"), "utf8"),
    `${digest}  openwrangler.vsix\n`
  );
});

test("incomplete source documentation remains valid while canonical stable authoring refuses it", async (context) => {
  const featureParity = parityMatrix(
    new Map([
      [PRIMARY_PARITY_SCOPE[0][0], "Partial"],
      ["Virtual grid, column sizing, navigation", "Partial"],
      ["Installed-editor first-usable-grid performance", "Partial"]
    ])
  ).replace("| Yes | Yes | Partial |", "| Yes | Partial | Partial |");
  const fixture = await createFixture(context, { featureParity });
  assert.deepEqual(
    inspectReleaseDocumentationSource({
      featureParity,
      preview: false,
      trackedEvidencePaths: new Set(["scripts/evidence.test.mjs"]),
      version: stablePackage.version
    }),
    []
  );
  await assert.rejects(
    createCanonicalReleaseArtifact(artifactOptions(fixture).options),
    /Canonical stable release readiness failed:.*File entry points; Windows Polars JSONL excludes glob paths.*Partial.*Yes\/Partial.*Virtual grid, column sizing, navigation.*Installed-editor first-usable-grid performance/su
  );
  assert.equal(existsSync(fixture.outputDirectory), false);
});

test("source documentation validates incomplete rows, applicability and tracked evidence", () => {
  const inspect = (featureParity) =>
    inspectReleaseDocumentationSource({
      featureParity,
      preview: false,
      trackedEvidencePaths: new Set(["scripts/evidence.test.mjs"]),
      version: stablePackage.version
    });
  for (const [status, availability] of [
    ["Done", "Yes"],
    ["Partial", "Partial"],
    ["Planned", "No"],
    ["Out of scope", "No"]
  ]) {
    const featureParity = parityMatrix(new Map([[PRIMARY_PARITY_SCOPE[0][0], status]])).replace(
      `| Yes | Yes | ${status} |`,
      `| Yes | ${availability} | ${status} |`
    );
    assert.deepEqual(inspect(featureParity), [], status);
  }
  const partial = parityMatrix(new Map([[PRIMARY_PARITY_SCOPE[0][0], "Partial"]]));
  const firstRow = partial.split("\n").find((line) => line.startsWith(`| ${PRIMARY_PARITY_SCOPE[0][0]} |`));
  const secondRow = partial.split("\n").find((line) => line.startsWith(`| ${PRIMARY_PARITY_SCOPE[1][0]} |`));
  assert.deepEqual(inspect(partial.replace(`${firstRow}\n${secondRow}`, `${secondRow}\n${firstRow}`)), []);
  const complete = partial.replace("| Partial |", "| Done |");
  const completeFirstRow = firstRow.replace("| Partial |", "| Done |");
  const inspectStrict = (featureParity) =>
    inspectPrimaryParityMatrix(featureParity, PRIMARY_PARITY_SCOPE, new Set(["scripts/evidence.test.mjs"]));
  assert.deepEqual(
    inspectStrict(complete.replace(`${completeFirstRow}\n${secondRow}`, `${secondRow}\n${completeFirstRow}`)),
    []
  );
  for (const incomplete of [
    partial,
    complete.replace(completeFirstRow, ""),
    complete.replace(secondRow, completeFirstRow)
  ]) {
    assert.notDeepEqual(inspectStrict(incomplete), []);
  }
  for (const referenceText of [
    "test:scripts/evidence.test.mjs",
    "Future inputs retain their source; test:scripts/evidence.test.mjs"
  ]) {
    assert.deepEqual(
      inspect(partial.replace("Exact canonical artifact accepted; test:scripts/evidence.test.mjs", referenceText)),
      []
    );
  }
  for (const malformed of [
    partial.replace(firstRow, ""),
    partial.replace(secondRow, firstRow),
    partial.replace(PRIMARY_PARITY_SCOPE[0][0], "Unknown surface"),
    partial.replace("| Partial |", "| Complete |"),
    partial.replace("| Yes | Yes | Partial |", "| Yes | Maybe | Partial |"),
    partial.replace("| Yes | Yes | Partial |", "| Yes | N/A | Partial |"),
    partial.replace("| N/A | N/A | Done |", "| Yes | N/A | Done |"),
    partial.replace("test:scripts/evidence.test.mjs", "test:scripts/untracked.test.mjs"),
    partial.replace("test:scripts/evidence.test.mjs", "workflow:scripts/evidence.test.mjs"),
    partial.replace("test:scripts/evidence.test.mjs", "test:"),
    partial.replace("test:scripts/evidence.test.mjs", "record:../outside.md"),
    partial.replace("Exact canonical artifact accepted; test:scripts/evidence.test.mjs", "Existing limitation"),
    partial.replace("# Feature parity matrix", "# Different document")
  ]) {
    assert.notDeepEqual(inspect(malformed), [], malformed.split("\n").slice(0, 6).join("\n"));
  }
});

test("source documentation retains channel rules and visible Native R support disclosure", () => {
  const disclosure = nativeRPreviewDisclosure();
  const stable = {
    featureParity: `${parityMatrix()}\n${disclosure}`,
    preview: false,
    trackedEvidencePaths: new Set(["scripts/evidence.test.mjs"]),
    version: "2.1.0"
  };
  assert.deepEqual(inspectReleaseDocumentationSource(stable), []);
  for (const body of [
    "R support is **Preview**. See [qualification](releasing.md).",
    `| Entry path | Current support |
| --- | --- |
| IRkernel notebook | Preview |`,
    "R notebook support is Preview.\n\n### Graduation\n\nQualify the immutable candidate."
  ]) {
    assert.deepEqual(
      inspectReleaseDocumentationSource({
        ...stable,
        featureParity: `${parityMatrix()}\n## Native R preview\n\n${body}`
      }),
      []
    );
  }
  for (const changed of [{ version: "bad" }, { preview: undefined }, { preview: true }]) {
    assert.notDeepEqual(inspectReleaseDocumentationSource({ ...stable, ...changed }), []);
  }
  for (const hiddenOrMissing of [
    "",
    `\`\`\`md\n${disclosure}\n\`\`\``,
    `<!--\n${disclosure}\n-->`,
    disclosure
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    `${disclosure}\n${disclosure}`,
    disclosure.replace("## Native R preview", "## Native R stable"),
    disclosure.replace("## Native R preview", "## **Native R preview**"),
    `${disclosure}\n## Native R stable\n\nSupported.`,
    "## Native R preview\n\n",
    "## Native R preview\n\n## Other capabilities\n\nSupported.",
    `<div hidden>\n\n${disclosure}\n</div>`,
    "## Native R preview\n\n<span hidden>Preview support</span>"
  ]) {
    assert.notDeepEqual(
      inspectReleaseDocumentationSource({ ...stable, featureParity: `${parityMatrix()}\n${hiddenOrMissing}` }),
      [],
      hiddenOrMissing
    );
  }
  assert.deepEqual(
    inspectReleaseDocumentationSource({ ...stable, version: "1.0.0", featureParity: parityMatrix() }),
    []
  );
  const preview = {
    ...stable,
    featureParity: disclosure,
    preview: true,
    version: previewPackage.version
  };
  assert.deepEqual(inspectReleaseDocumentationSource(preview), []);
  assert.notDeepEqual(inspectReleaseDocumentationSource({ ...preview, preview: false }), []);
  assert.notDeepEqual(inspectReleaseDocumentationSource({ ...preview, featureParity: "" }), []);
});

test("atomically publishes a provenance-bound preview triple before its tag exists", async (context) => {
  const fixture = await createFixture(context, {
    manifest: previewPackage,
    parityStatuses: new Map([["Dataset summary and quick insights", "Partial"]]),
    readmeSection: "This preview is intentionally not a stable release.",
    tag: false
  });
  const { options, state } = artifactOptions(fixture, {
    publicationMode: PREVIEW_RELEASE_PUBLICATION_MODE
  });
  const receipt = await createCanonicalReleaseArtifact(options);

  assert.equal(receipt.publicationMode, PREVIEW_RELEASE_PUBLICATION_MODE);
  assert.equal(receipt.releaseTag, "v0.3.0");
  assert.equal(receipt.sourceCommit, fixture.expectedCommit);
  assert.equal(receipt.files.length, 3);
  assert.deepEqual(readdirSync(fixture.outputDirectory).sort(), [
    "openwrangler.vsix",
    "openwrangler.vsix.provenance.json",
    "openwrangler.vsix.sha256"
  ]);
  const digest = createHash("sha256").update(fixture.candidateBytes).digest("hex");
  assert.equal(
    readFileSync(join(fixture.outputDirectory, "openwrangler.vsix.sha256"), "utf8"),
    `${digest}  openwrangler.vsix\n`
  );
  const provenance = validatePreviewReleaseProvenance(
    parseStrictJson(readFileSync(join(fixture.outputDirectory, "openwrangler.vsix.provenance.json"), "utf8"))
  );
  assert.deepEqual(provenance, {
    protocol: CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "0.3.0",
    preview: true,
    releaseTag: "v0.3.0",
    sourceCommit: fixture.expectedCommit,
    vsixSha256: digest,
    vsixBytes: fixture.candidateBytes.length
  });
  assert.equal(state.inventoryChecks, 1);
  assert.equal(state.pins, 2);
  assert.equal(state.reproducibleChecks, 1);
  assert.equal(state.sourceComparisons, 1);
  assert.deepEqual(state.callOrder, [
    "pinPackageSources",
    "assertReproducibleVsixArchive",
    "assertPackageInventory",
    "pinPackageSources",
    "assertSamePackageSources"
  ]);
});

test("new canonical authoring rejects a valid legacy-deflated VSIX without weakening legacy verification", async (context) => {
  const fixture = await createFixture(context, { useLegacyVsix: true });
  const inspected = await inspectVsixArchive(fixture.candidateBytes);
  assert.equal(parseStrictJson(inspected.packagedPackageJson).version, stablePackage.version);

  const legacyDirectory = join(fixture.root, "legacy-canonical-artifact");
  mkdirSync(legacyDirectory);
  const digest = createHash("sha256").update(fixture.candidateBytes).digest("hex");
  writeFileSync(join(legacyDirectory, "openwrangler.vsix"), fixture.candidateBytes);
  writeFileSync(join(legacyDirectory, "openwrangler.vsix.sha256"), `${digest}  openwrangler.vsix\n`);
  writeFileSync(
    join(legacyDirectory, "openwrangler.vsix.provenance.json"),
    `${JSON.stringify({
      protocol: CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: stablePackage.version,
      preview: false,
      releaseTag: fixture.releaseTag,
      sourceCommit: fixture.expectedCommit,
      vsixSha256: digest,
      vsixBytes: fixture.candidateBytes.length
    })}\n`
  );
  const legacyReceipt = await verifyCanonicalReleaseArtifact({
    directory: legacyDirectory,
    expectedCommit: fixture.expectedCommit,
    releaseTag: fixture.releaseTag,
    sourceCommit: fixture.expectedCommit,
    sourcePackageJson: JSON.stringify(stablePackage)
  });
  assert.equal(legacyReceipt.candidateSha256, digest);

  await assert.rejects(
    createCanonicalReleaseArtifact({
      ...fixture,
      dependencies: realPackageDependencies()
    }),
    /not in exact reproducible canonical form/u
  );
  assert.equal(existsSync(fixture.outputDirectory), false);
});

test("preview and stable artifact authors reject the opposite release channel", async (context) => {
  const stableFixture = await createFixture(context);
  await assert.rejects(
    createCanonicalReleaseArtifact(
      artifactOptions(stableFixture, { publicationMode: PREVIEW_RELEASE_PUBLICATION_MODE }).options
    ),
    /Canonical preview release readiness failed:.*not reserved for preview.*preview must be true/su
  );
  assert.equal(existsSync(stableFixture.outputDirectory), false);

  const previewFixture = await createFixture(context, { manifest: previewPackage });
  await assert.rejects(
    createCanonicalReleaseArtifact(artifactOptions(previewFixture).options),
    /Canonical stable release readiness failed:.*reserved for preview.*preview must be false/su
  );
  assert.equal(existsSync(previewFixture.outputDirectory), false);
});

test("rejects unknown artifact publication modes before reading or publishing a candidate", async (context) => {
  const fixture = await createFixture(context);
  for (const publicationMode of ["performance-evidence", "evidence-ish"]) {
    const { options, state } = artifactOptions(fixture, { publicationMode });
    await assert.rejects(
      createCanonicalReleaseArtifact(options),
      /publication mode must be stable-release or preview-release/u
    );
    assert.deepEqual(state.callOrder, []);
    assert.equal(existsSync(fixture.outputDirectory), false);
  }
});

test("production dependency composition pins and verifies the complete package inventory", async (context) => {
  const fixture = await createFixture(context);
  const receipt = await createCanonicalReleaseArtifact({
    ...fixture,
    dependencies: realPackageDependencies()
  });

  assert.equal(receipt.files.length, 3);
  assert.deepEqual(readFileSync(join(fixture.outputDirectory, "openwrangler.vsix")), fixture.candidateBytes);
  assert.throws(
    () => createCanonicalReleaseDependencies({ packageSourceOptions: [] }),
    /package-source options must be one object/u
  );
});

test("requires an absent output directory so the complete set can appear in one rename", async (context) => {
  const fixture = await createFixture(context);
  mkdirSync(fixture.outputDirectory);
  const { options } = artifactOptions(fixture);
  await assert.rejects(
    createCanonicalReleaseArtifact(options),
    /must not exist; pre-created empty directories cannot be atomically published/u
  );
  assert.deepEqual(readdirSync(fixture.outputDirectory), []);
});

test("rejects dirty tracked source and a tag that does not bind EXPECTED_SHA", async (context) => {
  const dirty = await createFixture(context);
  writeFileSync(join(dirty.root, "README.md"), "# changed\n");
  await assert.rejects(
    createCanonicalReleaseArtifact(artifactOptions(dirty).options),
    /clean tracked worktree and index/u
  );
  assert.equal(existsSync(dirty.outputDirectory), false);

  const mistagged = await createFixture(context);
  writeSourceFile(mistagged.root, "scripts/second.mjs", "export {};\n");
  runGit(mistagged.root, ["add", "."]);
  runGit(mistagged.root, ["commit", "-q", "-m", "move head"]);
  mistagged.expectedCommit = runGit(mistagged.root, ["rev-parse", "HEAD"]);
  await assert.rejects(
    createCanonicalReleaseArtifact(artifactOptions(mistagged).options),
    /RELEASE_TAG must resolve to the exact EXPECTED_SHA/u
  );
  assert.equal(existsSync(mistagged.outputDirectory), false);
});

test("removes private staging when source drifts immediately before publication", async (context) => {
  const fixture = await createFixture(context);
  const { options } = artifactOptions(fixture, {
    hooks: {
      beforePublishRename() {
        writeFileSync(join(fixture.root, "README.md"), "# changed during publication\n");
      }
    }
  });
  await assert.rejects(createCanonicalReleaseArtifact(options), /clean tracked worktree and index/u);
  assert.equal(existsSync(fixture.outputDirectory), false);
  assert.equal(
    readdirSync(fixture.root).some((name) => name.startsWith(".canonical-release.tmp-")),
    false
  );
});

test("retains a changed published member when its full cleanup receipt no longer matches", async (context) => {
  const fixture = await createFixture(context);
  const provenancePath = join(fixture.outputDirectory, "openwrangler.vsix.provenance.json");
  const { options } = artifactOptions(fixture, {
    hooks: {
      afterPublishRename() {
        chmodSync(provenancePath, 0o600);
        writeFileSync(provenancePath, "{}\n");
      }
    }
  });
  await assert.rejects(createCanonicalReleaseArtifact(options), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /publication and cleanup failed/u);
    assert.ok(
      error.errors.some((entry) =>
        /Canonical release file identity changed|Refusing to clean an unverified canonical release file/u.test(
          entry.message
        )
      )
    );
    return true;
  });
  assert.equal(existsSync(fixture.outputDirectory), true);
  assert.equal(readFileSync(provenancePath, "utf8"), "{}\n");
});

posixTest("retains a publication whose directory mode no longer matches its receipt", async (context) => {
  const fixture = await createFixture(context);
  const { options } = artifactOptions(fixture, {
    hooks: {
      afterPublishRename() {
        chmodSync(fixture.outputDirectory, 0o750);
      }
    }
  });
  await assert.rejects(createCanonicalReleaseArtifact(options), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /publication and cleanup failed/u);
    assert.ok(error.errors.every((entry) => /directory.*changed/iu.test(entry.message)));
    return true;
  });
  assert.equal(existsSync(fixture.outputDirectory), true);
  assert.equal(readdirSync(fixture.outputDirectory).length, 3);
});

test("revalidates the candidate after atomic publication and cleans the output on drift", async (context) => {
  const fixture = await createFixture(context);
  const { options } = artifactOptions(fixture, {
    hooks: {
      afterPublishRename() {
        writeFileSync(fixture.candidatePath, Buffer.concat([fixture.candidateBytes, Buffer.from("changed")]));
      }
    }
  });
  await assert.rejects(
    createCanonicalReleaseArtifact(options),
    /candidate changed during canonical artifact publication/u
  );
  assert.equal(existsSync(fixture.outputDirectory), false);
});

test("rejects linked candidate aliases without creating an output set", async (context) => {
  const hardLinked = await createFixture(context);
  const hardLink = join(hardLinked.root, "candidate-hardlink.vsix");
  linkSync(hardLinked.candidatePath, hardLink);
  await assert.rejects(
    createCanonicalReleaseArtifact(artifactOptions(hardLinked).options),
    /one regular, unlinked file/u
  );
  assert.equal(existsSync(hardLinked.outputDirectory), false);
  unlinkSync(hardLink);

  if (process.platform !== "win32") {
    const symlinked = await createFixture(context);
    const source = symlinked.candidatePath;
    unlinkSync(source);
    const target = join(symlinked.root, "candidate-target.vsix");
    writeFileSync(target, symlinked.candidateBytes, { flag: "wx", mode: 0o600 });
    symlinkSync(target, source);
    await assert.rejects(
      createCanonicalReleaseArtifact(artifactOptions(symlinked).options),
      /one regular, unlinked file|cannot be inspected/u
    );
    assert.equal(existsSync(symlinked.outputDirectory), false);
  }
});

test("rejects noncanonical provenance fields", () => {
  const valid = {
    protocol: CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "1.0.0",
    preview: false,
    releaseTag: "v1.0.0",
    sourceCommit: "a".repeat(40),
    vsixSha256: "b".repeat(64),
    vsixBytes: 1
  };
  assert.deepEqual(validateCanonicalReleaseProvenance(valid), valid);
  assert.throws(
    () => validateCanonicalReleaseProvenance({ ...valid, untrusted: true }),
    /exactly the canonical artifact fields/u
  );
  assert.throws(
    () => validateCanonicalReleaseProvenance({ ...valid, preview: true }),
    /one canonical stable artifact/u
  );

  const preview = {
    ...valid,
    protocol: CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
    extensionVersion: "0.3.0",
    preview: true,
    releaseTag: "v0.3.0"
  };
  assert.deepEqual(validatePreviewReleaseProvenance(preview), preview);
  assert.throws(
    () => validatePreviewReleaseProvenance({ ...preview, preview: false }),
    /one canonical preview artifact/u
  );
  assert.throws(
    () => validatePreviewReleaseProvenance({ ...preview, unknown: true }),
    /exactly the canonical artifact fields/u
  );
});
