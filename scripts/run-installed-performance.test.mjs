import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installedPerformanceDisplayMode,
  packageInstalledPerformanceCandidate,
  parseInstalledPerformanceArguments,
  readInstalledPerformanceCandidate,
  runInstalledMeasuredEditorPhase,
  stageInstalledPerformanceVsix,
  writeInstalledPerformanceRun
} from "./run-installed-performance.mjs";

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
    async build() {
      events.push("build");
    },
    async packageCandidate(destination) {
      events.push(["package", destination]);
    },
    async verifyCandidate(destination) {
      events.push(["verify", destination]);
    },
    snapshotCandidate(source, destination) {
      events.push(["snapshot", source, destination]);
      return { path: destination, sha256: "b".repeat(64), bytes: 123 };
    }
  });

  assert.deepEqual(receipt, {
    path: "/private/snapshot.vsix",
    sha256: "b".repeat(64),
    bytes: 123,
    source: clean
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.source), true);
  assert.deepEqual(events, [
    "source",
    "build",
    "source",
    ["package", "/private/candidate.vsix"],
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
        build: () => {},
        packageCandidate: () => {},
        verifyCandidate: () => {
          verified = true;
        },
        snapshotCandidate: () => ({ path: "/private/snapshot.vsix", sha256: "b".repeat(64), bytes: 123 })
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
        snapshotCandidate: () => ({ path: "/private/snapshot.vsix", sha256: "b".repeat(64), bytes: 123 })
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
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
      /single-link regular VSIX/u
    );
    await link(source, hard);
    assert.throws(
      () => stageInstalledPerformanceVsix(source, join(directory, "hard-copy.vsix")),
      /single-link regular VSIX/u
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
