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
  CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
  createCanonicalReleaseArtifact,
  createCanonicalReleaseDependencies,
  validateCanonicalReleaseProvenance
} from "./create-canonical-release-artifact.mjs";
import { PRIMARY_PARITY_SCOPE, STABLE_README_RELEASE_SECTION } from "./release-readiness.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011";
const stablePackage = Object.freeze({
  name: "openwrangler",
  displayName: "Open Wrangler",
  publisher: "Matt17BR",
  version: "1.0.0",
  preview: false
});
const posixTest = process.platform === "win32" ? test.skip : test;

function runGit(root, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  }).trim();
}

function vsixManifest() {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest xmlns="${namespace}">
  <Metadata>
    <Identity Id="openwrangler" Publisher="Matt17BR" Version="1.0.0" />
    <Properties></Properties>
  </Metadata>
</PackageManifest>`;
}

function parityMatrix() {
  const rows = PRIMARY_PARITY_SCOPE.map(
    ([surface, pandas, polars]) =>
      `| ${surface} | ${pandas} | ${polars} | Done | Exact canonical artifact accepted; test:scripts/evidence.test.mjs |`
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

function releaseEntries() {
  return new Map([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'],
    ["extension.vsixmanifest", vsixManifest()],
    ["extension/package.json", JSON.stringify(stablePackage)],
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
    ["extension/media/activity-icon.svg", "<svg></svg>"],
    ["extension/media/icon.png", "icon"],
    ["extension/media/icon-128.png", "icon"],
    ["extension/python/openwrangler_runtime/dependency_guard.py", "pass\n"],
    ["extension/python/openwrangler_runtime/server.py", "pass\n"],
    ["extension/python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n']
  ]);
}

function createVsixBuffer() {
  const zip = new ZipFile();
  for (const [name, value] of releaseEntries()) {
    zip.addBuffer(Buffer.from(value), name);
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

function writeSourceFile(root, path, contents) {
  const target = join(root, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents);
}

async function createFixture(context) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-canonical-artifact-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  runGit(root, ["init", "-q"]);
  runGit(root, ["config", "user.email", "canonical@example.invalid"]);
  runGit(root, ["config", "user.name", "Canonical Artifact Test"]);
  writeSourceFile(root, "package.json", `${JSON.stringify(stablePackage, null, 2)}\n`);
  writeSourceFile(root, "python/openwrangler_runtime/version.py", '__version__ = "1.0.0"\n');
  writeSourceFile(root, "docs/feature-parity.md", parityMatrix());
  writeSourceFile(
    root,
    "CHANGELOG.md",
    "# Changelog\n\n## [1.0.0] - 2026-07-27\n\n### Added\n\n- Published the verified stable package.\n"
  );
  writeSourceFile(root, "README.md", `# Open Wrangler\n\n${STABLE_README_RELEASE_SECTION}\n`);
  writeSourceFile(root, "scripts/evidence.test.mjs", "export {};\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-q", "-m", "stable fixture"]);
  const expectedCommit = runGit(root, ["rev-parse", "HEAD"]);
  runGit(root, ["tag", "v1.0.0"]);
  const candidatePath = join(root, "openwrangler.candidate.vsix");
  const candidateBytes = await createVsixBuffer();
  writeFileSync(candidatePath, candidateBytes, { flag: "wx", mode: 0o600 });
  return {
    candidateBytes,
    candidatePath,
    expectedCommit,
    outputDirectory: join(root, "canonical-release"),
    releaseTag: "v1.0.0",
    root
  };
}

function packageDependencies() {
  const state = {
    inventoryChecks: 0,
    pins: 0,
    sourceComparisons: 0
  };
  const receipt = Object.freeze({ protocol: "test-package-source-v1" });
  return {
    dependencies: {
      assertPackageInventory(_source, entries, digests) {
        assert.equal(_source, receipt);
        assert.ok(entries.includes("extension/package.json"));
        assert.ok(digests.some(([name]) => name === "extension/package.json"));
        state.inventoryChecks += 1;
      },
      assertSamePackageSources(expected, actual) {
        assert.equal(expected, receipt);
        assert.equal(actual, receipt);
        state.sourceComparisons += 1;
      },
      async pinPackageSources() {
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
  assert.equal(state.sourceComparisons, 1);
  assert.deepEqual(readFileSync(fixture.candidatePath), fixture.candidateBytes);
  assert.equal(
    readdirSync(fixture.root).some((name) => name.startsWith(".canonical-release.tmp-")),
    false
  );
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
    /stable candidate changed during canonical artifact publication/u
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
});
