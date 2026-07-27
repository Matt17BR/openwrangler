import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { readFileSync, renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL, editorProcessTreeMayBeLive } from "./editor-acceptance.mjs";
import {
  assertInstalledPerformancePackageInventory,
  assertNoPackageableUntrackedFiles,
  assertSameInstalledPerformancePackageSources,
  cleanupInstalledPerformancePrivateRoot,
  collectInstalledPerformanceEditorRuns,
  installInstalledPerformanceCandidate,
  installedPerformanceDisplayMode,
  packageInstalledPerformanceCandidate as packageInstalledPerformanceCandidateImplementation,
  parseInstalledPerformanceArguments,
  publishInstalledPerformanceReleaseResult,
  readBoundedJson,
  readInstalledPerformanceFragment,
  readInstalledPerformanceCandidate,
  readInstalledPerformanceSourceManifest,
  revalidateInstalledPerformanceVsix,
  runInstalledMeasuredEditorPhase,
  stageInstalledPerformanceVsix,
  validateInstalledPerformanceSourceManifest,
  writeInstalledPerformanceRun
} from "./run-installed-performance.mjs";

const fakeFileIdentity = Object.freeze({
  dev: 1n,
  ino: 2n,
  size: 123n,
  mtimeNs: 3n,
  ctimeNs: 4n
});

function packageInstalledPerformanceCandidate(options) {
  return packageInstalledPerformanceCandidateImplementation({
    assertPackageSource: () => packageSourceReceipt(["package.json"]),
    verifyPackageInventory: () => {},
    ...options
  });
}

function archiveEntryForPackageFile(file) {
  const lower = file.toLowerCase();
  if (lower === "readme.md") return "extension/readme.md";
  if (lower === "changelog.md") return "extension/changelog.md";
  if (lower === "license" || lower === "license.txt" || lower === "license.md") return "extension/LICENSE.txt";
  return `extension/${file}`;
}

function packageFileReceipt({ path, sha256 = "a".repeat(64), identity = fakeFileIdentity }) {
  return Object.freeze({
    path,
    archiveEntry: archiveEntryForPackageFile(path),
    bytes: Number(identity.size),
    sha256,
    fileIdentity: identity
  });
}

function packageSourceReceipt(packageFiles, generatedFiles = [], trackedFiles = undefined) {
  const generatedPaths = new Set(generatedFiles.map(({ path }) => path));
  return Object.freeze({
    packageFiles: Object.freeze([...packageFiles].sort()),
    trackedFiles: Object.freeze(
      (trackedFiles ?? packageFiles.filter((path) => !generatedPaths.has(path)).map((path) => ({ path }))).map(
        packageFileReceipt
      )
    ),
    generatedFiles: Object.freeze(generatedFiles.map(packageFileReceipt))
  });
}

function archiveDigestsForPackageSource(receipt) {
  return [...receipt.trackedFiles, ...receipt.generatedFiles].map(({ archiveEntry, sha256 }) => [archiveEntry, sha256]);
}

function previewSourceManifest(overrides = {}) {
  return {
    publisher: "Matt17BR",
    name: "openwrangler",
    version: "0.3.0",
    preview: true,
    ...overrides
  };
}

test("installed performance assigns unfocused release display modes per editor", () => {
  assert.equal(installedPerformanceDisplayMode({ key: "vscode" }, {}), "headless");
  assert.equal(installedPerformanceDisplayMode({ key: "cursor" }, {}), "xvfb");
  assert.equal(
    installedPerformanceDisplayMode({ key: "cursor" }, { OPEN_WRANGLER_EDITOR_DISPLAY: "current" }),
    "current"
  );
  assert.throws(
    () => installedPerformanceDisplayMode({ key: "vscode" }, { OPEN_WRANGLER_EDITOR_DISPLAY: "invalid" }),
    /headless.*xvfb.*current/u
  );
});

test("process-tree uncertainty prevents every private-root receipt access and cleanup", () => {
  const error = new Error("surviving editor process group");
  error.details = { treeVerifiedStopped: false };
  const receipt = new Proxy(
    {},
    {
      get() {
        assert.fail("uncertain cleanup must not inspect the private-root receipt");
      }
    }
  );
  let cleanupCalls = 0;

  assert.equal(editorProcessTreeMayBeLive(error), true);
  assert.equal(
    cleanupInstalledPerformancePrivateRoot({
      processTreeUncertain: editorProcessTreeMayBeLive(error),
      receipt,
      removePrivateRoot() {
        cleanupCalls += 1;
      }
    }),
    false
  );
  assert.equal(cleanupCalls, 0);
});

test("installed performance arguments default to both first-class editors", () => {
  const parsed = parseInstalledPerformanceArguments([]);

  assert.equal(parsed.smoke, false);
  assert.deepEqual(parsed.editors, ["vscode", "cursor"]);
  assert.match(parsed.candidateOutput, /tmp[/\\]performance[/\\]openwrangler-installed-candidate\.vsix$/u);
  assert.match(parsed.output, /tmp[/\\]performance[/\\]installed-performance\.json$/u);
});

test("installed performance arguments support explicit smoke editor sharding", () => {
  const parsed = parseInstalledPerformanceArguments([
    "--smoke",
    "--editors",
    "vscode",
    "--candidate-out",
    "tmp/custom.vsix",
    "--out",
    "tmp/custom.json"
  ]);

  assert.equal(parsed.smoke, true);
  assert.deepEqual(parsed.editors, ["vscode"]);
  assert.match(parsed.candidateOutput, /tmp[/\\]custom\.vsix$/u);
  assert.match(parsed.output, /tmp[/\\]custom\.json$/u);
  assert.throws(
    () => parseInstalledPerformanceArguments(["--editors", "vscode,vscode"]),
    /unique comma-separated subset/u
  );
  assert.throws(() => parseInstalledPerformanceArguments(["--unknown"]), /Unknown installed-performance option/u);
  assert.throws(() => parseInstalledPerformanceArguments(["candidate.vsix"]), /packages its own clean-HEAD candidate/u);
});

test("package source guard rejects packageable untracked files, including ignored generated-root extras", async () => {
  const runtimeFile = "python/openwrangler_runtime/user_file.py";
  const scratchFile = "scratch.txt";
  const tracked = ["package.json", "python/openwrangler_runtime/server.py"];

  await assert.rejects(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json", runtimeFile],
      deriveGeneratedFiles: () => new Set()
    }),
    /refuses to package an untracked or unexpected generated source file/u
  );
  await assert.rejects(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json", "media/webview.js", "media/rogue.js"],
      deriveGeneratedFiles: () => new Set(["media/webview.js"]),
      pinGeneratedFile: (path) => packageSourceReceipt([path], [{ path }]).generatedFiles[0]
    }),
    /refuses to package an untracked or unexpected generated source file/u
  );
  await assert.doesNotReject(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json"],
      pinTrackedFile: (path) => packageSourceReceipt([path]).trackedFiles[0],
      pinGeneratedFile: assert.fail,
      deriveGeneratedFiles: () => new Set()
    })
  );
  assert.deepEqual(tracked, ["package.json", "python/openwrangler_runtime/server.py"]);
  assert.equal(scratchFile, "scratch.txt");
});

test("package source guard pins every exact tracked and generated input", async () => {
  const source = await assertNoPackageableUntrackedFiles({
    readTrackedFiles: () => ["package.json"],
    listPackageFiles: async () => ["media/webview.js", "package.json"],
    deriveGeneratedFiles: () => new Set(["media/webview.js"]),
    pinTrackedFile: (path) => packageSourceReceipt([path]).trackedFiles[0],
    pinGeneratedFile: (path) => packageSourceReceipt([path], [{ path }]).generatedFiles[0]
  });
  assert.deepEqual(source, packageSourceReceipt(["media/webview.js", "package.json"], [{ path: "media/webview.js" }]));
});

test("pinned package inventory rejects a source file that appears only while createVSIX runs", () => {
  const pinnedBeforePackaging = ["package.json", "README.md", "LICENSE", "python/openwrangler_runtime/server.py"];
  const packageSource = packageSourceReceipt(pinnedBeforePackaging);
  const transientRuntimeFile = "extension/python/openwrangler_runtime/user_file.py";
  const archiveCreatedDuringPackaging = [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/python/openwrangler_runtime/server.py",
    transientRuntimeFile
  ];

  assert.throws(
    () => assertInstalledPerformancePackageInventory(packageSource, archiveCreatedDuringPackaging),
    /inventory drifted from its pinned pre-package source set/u
  );
  archiveCreatedDuringPackaging.pop();
  assert.doesNotThrow(() =>
    assertInstalledPerformancePackageInventory(
      packageSource,
      archiveCreatedDuringPackaging,
      archiveDigestsForPackageSource(packageSource)
    )
  );
});

test("pinned package sources reject tracked or generated source changes and archive-byte substitutions", () => {
  const before = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "a".repeat(64) }]
  );
  const changed = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "b".repeat(64), identity: { ...fakeFileIdentity, ino: 9n } }]
  );
  assert.throws(
    () => assertSameInstalledPerformancePackageSources(before, changed),
    /generated package output changed/u
  );
  const changedTracked = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "a".repeat(64) }],
    [{ path: "package.json", sha256: "b".repeat(64), identity: { ...fakeFileIdentity, ino: 8n } }]
  );
  assert.throws(
    () => assertSameInstalledPerformancePackageSources(before, changedTracked),
    /tracked package source changed/u
  );
  assert.throws(
    () =>
      assertInstalledPerformancePackageInventory(
        before,
        ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
        [
          ["extension/package.json", "a".repeat(64)],
          ["extension/media/webview.js", "b".repeat(64)]
        ]
      ),
    /source bytes drifted from their pinned package inputs/u
  );
  assert.throws(
    () =>
      assertInstalledPerformancePackageInventory(
        before,
        ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
        [
          ["extension/package.json", "c".repeat(64)],
          ["extension/media/webview.js", "a".repeat(64)]
        ]
      ),
    /source bytes drifted from their pinned package inputs/u
  );
  assert.doesNotThrow(() =>
    assertInstalledPerformancePackageInventory(
      before,
      ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
      [
        ["extension/package.json", "a".repeat(64)],
        ["extension/media/webview.js", "a".repeat(64)]
      ]
    )
  );
});

test("guarded packaging rejects the sealed candidate before verification when createVSIX adds a transient file", async () => {
  const pinned = ["package.json", "python/openwrangler_runtime/server.py"];
  let candidateVerified = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      assertPackageSource: () => packageSourceReceipt(pinned),
      packageCandidate: () => {},
      snapshotCandidate: (_source, destination) => ({
        path: destination,
        sha256: "b".repeat(64),
        bytes: 123,
        fileIdentity: fakeFileIdentity
      }),
      verifyPackageInventory(_receipt, packageSource) {
        assertInstalledPerformancePackageInventory(packageSource, [
          "[Content_Types].xml",
          "extension.vsixmanifest",
          "extension/package.json",
          "extension/python/openwrangler_runtime/server.py",
          "extension/python/openwrangler_runtime/transient.py"
        ]);
      },
      verifyCandidate() {
        candidateVerified = true;
      }
    }),
    /inventory drifted from its pinned pre-package source set/u
  );
  assert.equal(candidateVerified, false);
});

test("guarded candidate packaging checks packageable untracked files immediately around packaging", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  const events = [];
  await packageInstalledPerformanceCandidate({
    destination: "/private/candidate.vsix",
    snapshotDestination: "/private/snapshot.vsix",
    readSource: () => clean,
    readSourceManifest: () => previewSourceManifest(),
    build: () => {},
    assertPackageSource() {
      events.push("package-source");
      return packageSourceReceipt(["package.json"]);
    },
    packageCandidate() {
      events.push("package");
    },
    snapshotCandidate: (_source, destination) => ({
      path: destination,
      sha256: "b".repeat(64),
      bytes: 123,
      fileIdentity: fakeFileIdentity
    }),
    verifyPackageInventory(_receipt, packageSource) {
      assert.deepEqual(packageSource, packageSourceReceipt(["package.json"]));
      events.push("inventory");
    },
    verifyCandidate: () => {}
  });
  assert.deepEqual(events, ["package-source", "package", "package-source", "inventory"]);

  let packaged = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => clean,
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      assertPackageSource() {
        throw new Error("packageable untracked source");
      },
      packageCandidate() {
        packaged = true;
      }
    }),
    /packageable untracked source/u
  );
  assert.equal(packaged, false);
});

test("guarded candidate packaging pins one clean source through build, package, and verification", async () => {
  const commit = "a".repeat(40);
  const clean = { commit, trackedWorktreeDirty: false };
  const events = [];

  const receipt = await packageInstalledPerformanceCandidate({
    destination: "/private/candidate.vsix",
    snapshotDestination: "/private/snapshot.vsix",
    environment: {},
    readSource() {
      events.push("source");
      return clean;
    },
    readSourceManifest() {
      events.push("manifest");
      return previewSourceManifest();
    },
    async build() {
      events.push("build");
    },
    async packageCandidate(destination, options) {
      events.push(["package", destination, options]);
    },
    snapshotCandidate(source, destination) {
      events.push(["snapshot", source, destination]);
      return { path: destination, sha256: "b".repeat(64), bytes: 123, fileIdentity: fakeFileIdentity };
    },
    async verifyCandidate(receipt) {
      events.push(["verify", receipt.path]);
    }
  });

  assert.deepEqual(receipt, {
    path: "/private/snapshot.vsix",
    sha256: "b".repeat(64),
    bytes: 123,
    fileIdentity: fakeFileIdentity,
    source: clean,
    sourceManifest: {
      publisher: "Matt17BR",
      name: "openwrangler",
      version: "0.3.0",
      preview: true,
      channel: "preview"
    }
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.source), true);
  assert.equal(Object.isFrozen(receipt.sourceManifest), true);
  assert.deepEqual(events, [
    "source",
    "manifest",
    "build",
    "source",
    ["package", "/private/candidate.vsix", { preRelease: true }],
    "source",
    ["snapshot", "/private/candidate.vsix", "/private/snapshot.vsix"],
    "source",
    ["verify", "/private/snapshot.vsix"],
    "source"
  ]);
});

test("guarded verification receives the sealed snapshot before mutable build-output drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-seal-"));
  try {
    const destination = join(directory, "built.vsix");
    const snapshotDestination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained-built.vsix");
    const original = Buffer.from("candidate bytes verified from the immutable snapshot");
    const replacement = Buffer.from("replacement build output");

    const receipt = await packageInstalledPerformanceCandidate({
      destination,
      snapshotDestination,
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      packageCandidate(path) {
        writeFileSync(path, original, { flag: "wx", mode: 0o600 });
      },
      verifyCandidate(snapshot) {
        assert.equal(snapshot.path, snapshotDestination);
        renameSync(destination, retained);
        writeFileSync(destination, replacement, { flag: "wx", mode: 0o600 });
        assert.deepEqual(readFileSync(snapshot.path), original);
        revalidateInstalledPerformanceVsix(snapshot);
      }
    });

    assert.equal(receipt.path, snapshotDestination);
    assert.deepEqual(await readFile(receipt.path), original);
    assert.deepEqual(await readFile(destination), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guarded verification rejects an in-place mutation of the sealed snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-seal-"));
  try {
    const destination = join(directory, "built.vsix");
    const snapshotDestination = join(directory, "private", "candidate.vsix");
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination,
        snapshotDestination,
        readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
        readSourceManifest: () => previewSourceManifest(),
        build: () => {},
        packageCandidate(path) {
          writeFileSync(path, "sealed candidate bytes", { flag: "wx", mode: 0o600 });
        },
        verifyCandidate(snapshot) {
          writeFileSync(snapshot.path, "mutated candidate bytes");
          revalidateInstalledPerformanceVsix(snapshot);
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guarded candidate packaging rejects dirty or drifting checkout provenance", async () => {
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: true }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => assert.fail("a dirty checkout must fail before build"),
      packageCandidate: () => assert.fail("a dirty checkout must fail before package"),
      verifyCandidate: () => assert.fail("a dirty checkout must fail before verification")
    }),
    /clean exact HEAD before candidate build/u
  );

  const sources = [
    { commit: "a".repeat(40), trackedWorktreeDirty: false },
    { commit: "b".repeat(40), trackedWorktreeDirty: false }
  ];
  let packaged = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => sources.shift(),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      packageCandidate: () => {
        packaged = true;
      },
      verifyCandidate: () => assert.fail("source drift must fail before verification")
    }),
    /source commit changed during candidate build/u
  );
  assert.equal(packaged, false);

  for (const [dirtyRead, expectedStage, expectedVerified] of [
    [2, "during candidate build", false],
    [3, "during candidate packaging", false],
    [4, "during candidate snapshot", false],
    [5, "during candidate verification", true]
  ]) {
    let reads = 0;
    let verified = false;
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource() {
          reads += 1;
          return {
            commit: "a".repeat(40),
            trackedWorktreeDirty: reads === dirtyRead
          };
        },
        readSourceManifest: () => previewSourceManifest(),
        build: () => {},
        packageCandidate: () => {},
        verifyCandidate: () => {
          verified = true;
        },
        snapshotCandidate: () => ({
          path: "/private/snapshot.vsix",
          sha256: "b".repeat(64),
          bytes: 123,
          fileIdentity: fakeFileIdentity
        })
      }),
      new RegExp(`clean exact HEAD ${expectedStage}`, "u")
    );
    assert.equal(verified, expectedVerified);
  }
});

test("guarded candidate packaging never advances after a failed build, package, or verification", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  for (const failedStage of ["build", "package", "verify"]) {
    const events = [];
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource: () => clean,
        readSourceManifest: () => previewSourceManifest(),
        build() {
          events.push("build");
          if (failedStage === "build") throw new Error("build failed");
        },
        packageCandidate() {
          events.push("package");
          if (failedStage === "package") throw new Error("package failed");
        },
        verifyCandidate() {
          events.push("verify");
          if (failedStage === "verify") throw new Error("verify failed");
        },
        snapshotCandidate: () => ({
          path: "/private/snapshot.vsix",
          sha256: "b".repeat(64),
          bytes: 123,
          fileIdentity: fakeFileIdentity
        })
      }),
      new RegExp(`${failedStage} failed`, "u")
    );
    assert.deepEqual(
      events,
      failedStage === "build"
        ? ["build"]
        : failedStage === "package"
          ? ["build", "package"]
          : ["build", "package", "verify"]
    );
  }
});

test("guarded candidate packaging derives preview and stable channels from the source manifest", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  for (const expected of [
    { version: "0.3.0", preview: true, channel: "preview", preRelease: true },
    { version: "1.0.0", preview: false, channel: "stable", preRelease: false }
  ]) {
    let packageOptions;
    const receipt = await packageInstalledPerformanceCandidate({
      destination: `/private/${expected.channel}.vsix`,
      snapshotDestination: `/private/${expected.channel}-snapshot.vsix`,
      readSource: () => clean,
      readSourceManifest: () =>
        previewSourceManifest({
          version: expected.version,
          preview: expected.preview
        }),
      build: () => {},
      packageCandidate(_destination, options) {
        packageOptions = options;
      },
      verifyCandidate: () => {},
      snapshotCandidate: (_source, destination) => ({
        path: destination,
        sha256: "b".repeat(64),
        bytes: 123,
        fileIdentity: fakeFileIdentity
      })
    });

    assert.deepEqual(packageOptions, { preRelease: expected.preRelease });
    assert.deepEqual(receipt.sourceManifest, {
      publisher: "Matt17BR",
      name: "openwrangler",
      version: expected.version,
      preview: expected.preview,
      channel: expected.channel
    });
  }
});

test("source manifest validation rejects ambiguous identity, version, and release channels before build", async () => {
  const invalid = [
    [null, /object-valued source package manifest/u],
    [previewSourceManifest({ publisher: "someone-else" }), /canonical Matt17BR\.openwrangler/u],
    [previewSourceManifest({ name: "another-extension" }), /canonical Matt17BR\.openwrangler/u],
    [previewSourceManifest({ version: "1.0.0-alpha.1" }), /numeric major\.minor\.patch/u],
    [previewSourceManifest({ preview: "true" }), /explicit boolean package preview flag/u],
    [previewSourceManifest({ version: "0.9.0", preview: false }), /Preview-channel version 0\.9\.0/u],
    [previewSourceManifest({ version: "1.0.0", preview: true }), /stable channel/u],
    [previewSourceManifest({ version: "0.2.0", preview: false }), /1\.0\.0 or newer/u]
  ];
  for (const [manifest, expectedError] of invalid) {
    assert.throws(() => validateInstalledPerformanceSourceManifest(manifest), expectedError);
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
        readSourceManifest: () => manifest,
        build: () => assert.fail("an invalid source manifest must fail before build")
      }),
      expectedError
    );
  }
});

test("source manifest reading returns only canonical release-channel provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-manifest-"));
  try {
    const manifestPath = join(directory, "package.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...previewSourceManifest({ version: "1.0.0", preview: false }),
        displayName: "Open Wrangler",
        scripts: { build: "ignored" }
      })
    );

    assert.deepEqual(readInstalledPerformanceSourceManifest(manifestPath), {
      publisher: "Matt17BR",
      name: "openwrangler",
      version: "1.0.0",
      preview: false,
      channel: "stable"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate metadata rejects any receipt not minted by guarded packaging", async () => {
  await assert.rejects(
    readInstalledPerformanceCandidate({
      path: "/tmp/arbitrary.vsix",
      sha256: "b".repeat(64),
      bytes: 123,
      source: { commit: "a".repeat(40), trackedWorktreeDirty: false }
    }),
    /guarded build receipt/u
  );
});

test("the VSIX snapshot copies and hashes one pinned regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const bytes = Buffer.from("deterministic candidate bytes");
    await writeFile(source, bytes);

    const snapshot = stageInstalledPerformanceVsix(source, destination);

    assert.equal(snapshot.bytes, bytes.length);
    assert.equal(snapshot.sha256, "4fd9b5f5c728de97c6b47a9db2fa77ec840d29766f562b7cff26fe4a0a903391");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.fileIdentity), true);
    assert.equal(revalidateInstalledPerformanceVsix(snapshot), snapshot);
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX receipt rejects path substitution after editor installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "deterministic candidate");
    const receipt = stageInstalledPerformanceVsix(source, destination);

    renameSync(destination, retained);
    writeFileSync(destination, "substituted candidate");

    assert.throws(() => revalidateInstalledPerformanceVsix(receipt), /VSIX (receipt|path) changed/u);
    assert.equal(await readFile(destination, "utf8"), "substituted candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX receipt rejects checksum drift and a same-path swap during its descriptor snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "deterministic candidate");
    const receipt = stageInstalledPerformanceVsix(source, destination);

    assert.throws(
      () => revalidateInstalledPerformanceVsix({ ...receipt, sha256: "0".repeat(64) }),
      /checksum receipt/u
    );

    const originalReadFileSync = readFileSync;
    let swapped = false;
    context.mock.method(fs, "readFileSync", (...arguments_) => {
      if (!swapped && typeof arguments_[0] === "number") {
        swapped = true;
        renameSync(destination, retained);
        writeFileSync(destination, "replacement candidate", { flag: "wx", mode: 0o600 });
      }
      return originalReadFileSync(...arguments_);
    });

    assert.throws(() => revalidateInstalledPerformanceVsix(receipt), /changed while its descriptor snapshot was read/u);
    assert.equal(swapped, true);
    assert.equal(await readFile(destination, "utf8"), "replacement candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation validates the exact receipt at the editor CLI spawn boundary and after exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);
    const events = [];

    await installInstalledPerformanceCandidate({
      editor: { name: "VS Code", key: "vscode" },
      candidateReceipt: receipt,
      userData: join(directory, "user"),
      extensions: join(directory, "extensions"),
      sandboxArgs: ["--no-sandbox"],
      environment: {},
      revalidateCandidate(exactReceipt) {
        assert.equal(exactReceipt, receipt);
        revalidateInstalledPerformanceVsix(exactReceipt);
        events.push("validate");
      },
      spawnOwned(_executable, arguments_) {
        assert.equal(arguments_.filter((value) => value === receipt.path).length, 1);
        events.push("spawn");
        return { pid: 4812 };
      },
      async runCli(command, options) {
        assert.equal(command.args[command.args.indexOf("--install-extension") + 1], receipt.path);
        options.spawnProcess("/editor-cli", command.args, {});
        events.push("exit");
        return { stdout: "", stderr: "" };
      }
    });

    assert.deepEqual(events, ["validate", "spawn", "exit", "validate"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation rejects pre-spawn path substitution before the editor CLI starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);
    let spawned = false;

    await assert.rejects(
      installInstalledPerformanceCandidate({
        editor: { name: "VS Code", key: "vscode" },
        candidateReceipt: receipt,
        userData: join(directory, "user"),
        extensions: join(directory, "extensions"),
        sandboxArgs: [],
        environment: {},
        spawnOwned() {
          spawned = true;
          return { pid: 4812 };
        },
        async runCli(command, options) {
          renameSync(candidate, retained);
          writeFileSync(candidate, "substituted candidate", { flag: "wx", mode: 0o600 });
          options.spawnProcess("/editor-cli", command.args, {});
          return { stdout: "", stderr: "" };
        }
      }),
      /VSIX (receipt|path) changed/u
    );
    assert.equal(spawned, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation rejects same-inode drift introduced at the spawn boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);

    await assert.rejects(
      installInstalledPerformanceCandidate({
        editor: { name: "Cursor", key: "cursor" },
        candidateReceipt: receipt,
        userData: join(directory, "user"),
        extensions: join(directory, "extensions"),
        sandboxArgs: [],
        environment: {},
        spawnOwned() {
          writeFileSync(candidate, "candidate mutated after pre-spawn validation");
          return { pid: 4812 };
        },
        async runCli(command, options) {
          options.spawnProcess("/editor-cli", command.args, {});
          return { stdout: "", stderr: "" };
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor collection revalidates the exact VSIX receipt only after both editors finish", async () => {
  const events = [];
  const receipt = { marker: "candidate" };
  const publicReceipt = { marker: "public-candidate" };
  const runs = await collectInstalledPerformanceEditorRuns({
    editors: [{ key: "vscode" }, { key: "cursor" }],
    candidateReceipt: receipt,
    publicCandidateReceipt: publicReceipt,
    async runEditor(editor) {
      events.push(`run:${editor.key}`);
      return { editor: editor.key };
    },
    revalidateCandidate(candidate) {
      assert.ok(candidate === receipt || candidate === publicReceipt);
      events.push(`revalidate:${candidate.marker}`);
    }
  });

  assert.deepEqual(runs, [{ editor: "vscode" }, { editor: "cursor" }]);
  assert.deepEqual(events, ["run:vscode", "run:cursor", "revalidate:candidate", "revalidate:public-candidate"]);
});

test("editor collection rejects public candidate drift after the editor runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-public-"));
  try {
    const source = join(directory, "source.vsix");
    const privateCandidate = join(directory, "private.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes retained through final reporting");
    const privateReceipt = stageInstalledPerformanceVsix(source, privateCandidate);
    const publicReceipt = stageInstalledPerformanceVsix(privateCandidate, publicCandidate);

    await assert.rejects(
      collectInstalledPerformanceEditorRuns({
        editors: [{ key: "vscode" }],
        candidateReceipt: privateReceipt,
        publicCandidateReceipt: publicReceipt,
        async runEditor() {
          writeFileSync(publicCandidate, "public candidate drift before final reporting");
          return { editor: "vscode" };
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication rejects public candidate drift introduced while the report is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-final-"));
  try {
    const source = join(directory, "source.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes before final report publication");
    const publicReceipt = stageInstalledPerformanceVsix(source, publicCandidate);
    let reportRevalidated = false;

    assert.throws(
      () =>
        publishInstalledPerformanceReleaseResult({
          output: join(directory, "report.json"),
          result: { protocol: "test" },
          publicCandidateReceipt: publicReceipt,
          writeReport() {
            writeFileSync(publicCandidate, "candidate drift during final report publication");
            return { marker: "report" };
          },
          assertGate() {},
          revalidateReport() {
            reportRevalidated = true;
          }
        }),
      /VSIX (receipt|checksum)/u
    );
    assert.equal(reportRevalidated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication rejects candidate mutation while the report is revalidated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-joint-final-"));
  try {
    const source = join(directory, "source.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes before joint final validation");
    const publicReceipt = stageInstalledPerformanceVsix(source, publicCandidate);
    let reportReads = 0;

    assert.throws(
      () =>
        publishInstalledPerformanceReleaseResult({
          output: join(directory, "report.json"),
          result: { protocol: "test" },
          publicCandidateReceipt: publicReceipt,
          writeReport: () => ({ marker: "report" }),
          assertGate() {},
          revalidateReport(_receipt, hooks) {
            reportReads += 1;
            writeFileSync(publicCandidate, "candidate mutation while reading the report");
            hooks.afterOpen();
          }
        }),
      /VSIX (receipt|checksum)/u
    );
    assert.equal(reportReads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication jointly revalidates the candidate while the report is pinned and after its read", () => {
  const events = [];
  const candidateReceipt = { marker: "candidate" };
  const reportReceipt = { marker: "report" };
  assert.equal(
    publishInstalledPerformanceReleaseResult({
      output: "/private/report.json",
      result: { protocol: "test" },
      publicCandidateReceipt: candidateReceipt,
      writeReport(output) {
        events.push(["write", output]);
        return reportReceipt;
      },
      assertGate() {
        events.push(["gate"]);
      },
      revalidateCandidate(receipt) {
        assert.equal(receipt, candidateReceipt);
        events.push(["candidate"]);
      },
      revalidateReport(receipt, hooks) {
        assert.equal(receipt, reportReceipt);
        events.push(["report-open"]);
        hooks.afterOpen();
        events.push(["report-close"]);
      }
    }),
    reportReceipt
  );
  assert.deepEqual(events, [
    ["write", "/private/report.json"],
    ["gate"],
    ["candidate"],
    ["report-open"],
    ["candidate"],
    ["report-close"],
    ["candidate"]
  ]);
});

test("release publication rejects a report validator that cannot expose the joint read window", () => {
  assert.throws(
    () =>
      publishInstalledPerformanceReleaseResult({
        output: "/private/report.json",
        result: { protocol: "test" },
        publicCandidateReceipt: { marker: "candidate" },
        writeReport: () => ({ marker: "report" }),
        assertGate() {},
        revalidateCandidate() {},
        revalidateReport() {}
      }),
    /could not jointly validate its candidate and report/u
  );
});

test("the VSIX snapshot rejects symbolic and hard-linked candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const symbolic = join(directory, "symbolic.vsix");
    const hard = join(directory, "hard.vsix");
    await writeFile(source, "candidate");
    await symlink(source, symbolic);
    assert.throws(
      () => stageInstalledPerformanceVsix(symbolic, join(directory, "symbolic-copy.vsix")),
      /single-link regular VSIX|changed before it was staged/u
    );
    await link(source, hard);
    assert.throws(
      () => stageInstalledPerformanceVsix(source, join(directory, "hard-copy.vsix")),
      /single-link regular VSIX|changed before it was staged/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX snapshot rejects source substitution after descriptor acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    await writeFile(source, "original candidate");

    assert.throws(
      () =>
        stageInstalledPerformanceVsix(source, destination, {
          afterSourceOpen(openedPath) {
            renameSync(openedPath, retained);
            writeFileSync(openedPath, "substituted candidate");
          }
        }),
      /changed before it was staged/u
    );
    assert.equal(await readFile(source, "utf8"), "substituted candidate");
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads reject symlinks and path substitution while retaining the replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    const retained = join(directory, "retained.json");
    const symbolic = join(directory, "symbolic.json");
    await writeFile(source, JSON.stringify({ value: "original" }));
    await symlink(source, symbolic);

    assert.throws(() => readBoundedJson(symbolic, 1024), /invalid bounded JSON|changed before/u);
    assert.throws(
      () =>
        readBoundedJson(source, 1024, {
          afterOpen(openedPath) {
            renameSync(openedPath, retained);
            writeFileSync(openedPath, JSON.stringify({ value: "substituted" }));
          }
        }),
      /changed while it was read/u
    );
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { value: "substituted" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads reject a same-inode rewrite after descriptor validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    await writeFile(source, JSON.stringify({ value: "original" }));

    assert.throws(
      () =>
        readBoundedJson(source, 1024, {
          afterOpen(openedPath) {
            writeFileSync(openedPath, JSON.stringify({ value: "replacement-with-a-different-byte-size" }));
          }
        }),
      /changed while it was read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads use the shared strict parser and reject nested or escaped duplicate keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    for (const contents of [
      '{"protocol":"openwrangler-installed-performance-phase-v4","protocol":"drifted"}',
      '{"outer":{"phase":"expected","phase":"drifted"}}',
      '{"outer":{"phase":"expected","ph\\u0061se":"drifted"}}'
    ]) {
      await writeFile(source, contents);
      assert.throws(() => readBoundedJson(source, 1024), /must not contain duplicate keys/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("phase fragments must match the exact editor-host artifact receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-fragment-"));
  try {
    const source = join(directory, "phase.json");
    const contents = Buffer.from('{"protocol":"openwrangler-installed-performance-phase-v4"}', "utf8");
    await writeFile(source, contents);
    const receipt = {
      protocol: EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex")
    };

    assert.deepEqual(readInstalledPerformanceFragment(source, 1024, receipt), {
      protocol: "openwrangler-installed-performance-phase-v4"
    });
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, sha256: "0".repeat(64) }),
      /does not match its editor-host artifact receipt/u
    );
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, unexpected: true }),
      /invalid artifact receipt/u
    );
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, protocol: "unknown" }),
      /invalid artifact receipt/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the installed performance result writer replaces only a regular destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const destination = join(directory, "results", "installed-performance.json");
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 1 });
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 2 });
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { protocol: "test", value: 2 });

    const linked = join(directory, "linked.json");
    await mkdir(join(directory, "target"));
    await symlink(destination, linked);
    assert.throws(
      () => writeInstalledPerformanceRun(linked, { protocol: "test" }),
      /absent or a single-link regular file/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("measured editor phases attach after spawn and sample only after verified phase cleanup", async () => {
  const events = [];
  const child = { pid: 4812 };
  const artifactReceipt = { protocol: "receipt" };
  const returned = await runInstalledMeasuredEditorPhase({
    phase: "perf-parquet-warm",
    sampler: {
      begin(phase, processGroupId) {
        events.push(["begin", phase, processGroupId]);
      },
      end() {
        events.push(["end"]);
      }
    },
    spawnOwned() {
      events.push(["spawn"]);
      return child;
    },
    async runPhase(spawnProcess) {
      assert.equal(spawnProcess("editor", [], {}), child);
      events.push(["phase-clean"]);
      return artifactReceipt;
    }
  });
  assert.equal(returned, artifactReceipt);
  assert.deepEqual(events, [["spawn"], ["begin", "perf-parquet-warm", 4812], ["phase-clean"], ["end"]]);
});

test("RSS attachment faults never interrupt editor cleanup and aggregate with phase faults", async () => {
  const phaseError = new Error("phase cleanup failed");
  const samplerError = new Error("sampler attach failed");
  let phaseContinued = false;
  await assert.rejects(
    runInstalledMeasuredEditorPhase({
      phase: "perf-csv-cold",
      sampler: {
        begin() {
          throw samplerError;
        },
        end() {
          assert.fail("a sampler that never attached must not be ended");
        }
      },
      spawnOwned() {
        return { pid: 912 };
      },
      async runPhase(spawnProcess) {
        spawnProcess("editor", [], {});
        phaseContinued = true;
        throw phaseError;
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.includes(phaseError) &&
      error.errors.includes(samplerError)
  );
  assert.equal(phaseContinued, true);
});
