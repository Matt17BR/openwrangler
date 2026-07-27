import assert from "node:assert/strict";
import { renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { editorProcessTreeMayBeLive } from "./editor-acceptance.mjs";
import {
  cleanupInstalledPerformancePrivateRoot,
  collectInstalledPerformanceEditorRuns,
  installedPerformanceDisplayMode,
  packageInstalledPerformanceCandidate,
  parseInstalledPerformanceArguments,
  readBoundedJson,
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
    async verifyCandidate(destination) {
      events.push(["verify", destination]);
    },
    snapshotCandidate(source, destination) {
      events.push(["snapshot", source, destination]);
      return { path: destination, sha256: "b".repeat(64), bytes: 123, fileIdentity: fakeFileIdentity };
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
    ["verify", "/private/candidate.vsix"],
    "source",
    ["snapshot", "/private/candidate.vsix", "/private/snapshot.vsix"],
    "source"
  ]);
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
    [4, "during candidate verification", true],
    [5, "during candidate snapshot", true]
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
    [previewSourceManifest({ version: "0.9.0", preview: false }), /1\.0\.0 or newer/u]
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

test("editor collection revalidates the exact VSIX receipt only after both editors finish", async () => {
  const events = [];
  const receipt = { marker: "candidate" };
  const runs = await collectInstalledPerformanceEditorRuns({
    editors: [{ key: "vscode" }, { key: "cursor" }],
    candidateReceipt: receipt,
    async runEditor(editor) {
      events.push(`run:${editor.key}`);
      return { editor: editor.key };
    },
    revalidateCandidate(candidate) {
      assert.equal(candidate, receipt);
      events.push("revalidate");
    }
  });

  assert.deepEqual(runs, [{ editor: "vscode" }, { editor: "cursor" }]);
  assert.deepEqual(events, ["run:vscode", "run:cursor", "revalidate"]);
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
  await runInstalledMeasuredEditorPhase({
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
    }
  });
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
