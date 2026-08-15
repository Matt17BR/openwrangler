import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  assertSafeOutput,
  assertRuntimeMatchesLibraryReceipt,
  buildRPerformanceChildEnvironment,
  createRPerformanceLibraryReceipt,
  kernelResponseAccounting,
  normalizeRPerformanceCpuModel,
  parseRPerformanceArguments,
  parseRPerformanceLibraryProbeFrame,
  preflightRPerformanceLibraryEnvironment,
  R_PERFORMANCE_PROCESS_SCHEDULE,
  readRPerformanceCallerHomeReceipt,
  runRPerformanceLibraryProbe,
  runRPerformance,
  selectRPerformanceProvenanceReader,
  sendCorrelated,
  spawnOwnedRscript,
  validateClosedResponse,
  validateDatasetStatsResponse,
  validateLargeOpenResponse,
  validateLargeSummaryResponse,
  validateRPerformanceDirectFrame,
  validateSummaryResponse,
  writeRPerformancePrivateFile
} from "./run-r-performance.mjs";
import { R_PERFORMANCE_FIXTURE_DEFINITION } from "./r-performance-report.mjs";
import {
  CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL,
  CANONICAL_RELEASE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL
} from "./run-installed-performance.mjs";

const linuxOnly = { skip: platform() !== "linux" };

function fakeChild({
  pid = 2_147_400_000,
  stdin = new PassThrough(),
  stdout = new PassThrough(),
  stderr = new PassThrough()
} = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  return child;
}

function emitClosed(child, code = 0, signal = null) {
  child.stdout.end();
  child.stderr.end();
  setImmediate(() => {
    child.emit("exit", code, signal);
    child.emit("close", code, signal);
  });
}

function sourceBinding(root, harnessPath) {
  const metadata = lstatSync(harnessPath, { bigint: true });
  return {
    root,
    harnessPath,
    harness: {
      identity: { dev: metadata.dev, ino: metadata.ino }
    }
  };
}

test("native R CLI requires the exact four canonical path options", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-cli-test-"));
  try {
    const values = [
      "--candidate-in",
      "openwrangler.vsix",
      "--candidate-checksum",
      "openwrangler.vsix.sha256",
      "--candidate-provenance",
      "openwrangler.vsix.provenance.json",
      "--out",
      "report.json"
    ];
    const parsed = parseRPerformanceArguments(values, directory);
    assert.equal(parsed.candidateInput, join(directory, "openwrangler.vsix"));
    assert.equal(parsed.output, join(directory, "report.json"));
    assert.throws(() => parseRPerformanceArguments([...values, "--out", "again.json"], directory), /once|Unknown/iu);
    assert.throws(() => parseRPerformanceArguments(values.slice(0, -2), directory), /--out/iu);
    assert.throws(() => parseRPerformanceArguments(values.with(1, "renamed.vsix"), directory), /canonical filename/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native R provenance dispatch is explicit and never validator probing", () => {
  const stable = () => "stable";
  const preview = () => "preview";
  const evidence = () => "evidence";
  assert.deepEqual(selectRPerformanceProvenanceReader(CANONICAL_RELEASE_ARTIFACT_PROTOCOL, { stable }), {
    artifactKind: "canonical-stable-release",
    intakeArtifactKind: "stable-release",
    read: stable
  });
  assert.equal(
    selectRPerformanceProvenanceReader(CANONICAL_PREVIEW_RELEASE_ARTIFACT_PROTOCOL, { preview }).read,
    preview
  );
  assert.equal(selectRPerformanceProvenanceReader(PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL, { evidence }).read, evidence);
  assert.throws(() => selectRPerformanceProvenanceReader("unknown"), /unsupported/iu);
});

test("the fixed schedule derives 86 measured, 99 correlated, 8 closes, and 8 owned processes", () => {
  const accounting = kernelResponseAccounting();
  assert.equal(
    Object.values(accounting.measured).reduce((sum, value) => sum + value, 0),
    86
  );
  assert.equal(
    Object.values(accounting.controls).reduce((sum, value) => sum + value, 0),
    13
  );
  assert.equal(accounting.allTotal, 99);
  assert.equal(accounting.controls.sessionClose, 8);
  assert.deepEqual(R_PERFORMANCE_PROCESS_SCHEDULE, {
    libraryProbeRscriptProcesses: 1,
    directRscriptProcesses: 1,
    freshKernelRscriptProcesses: 5,
    workloadKernelRscriptProcesses: 1,
    measuredRscriptProcesses: 7,
    totalOwnedRscriptProcesses: 8
  });
});

function hex(value) {
  return Buffer.from(value, "utf8").toString("hex");
}

test("library discovery grammar and explicit measured-child environment are exact and path-private", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-library-environment-test-"));
  try {
    const privateRoot = join(directory, "private");
    const userLibrary = join(directory, "user-library");
    const siteLibrary = join(directory, "site-library");
    const baseLibrary = join(directory, "base-library");
    for (const entry of [privateRoot, userLibrary, siteLibrary, baseLibrary]) mkdirSync(entry);
    chmodSync(userLibrary, 0o775);
    const frame = [
      "openwrangler-native-r-library-discovery-v1",
      "3",
      hex(userLibrary),
      hex(siteLibrary),
      hex(baseLibrary),
      "1",
      hex(siteLibrary),
      hex(baseLibrary)
    ].join("\t");
    const decoded = parseRPerformanceLibraryProbeFrame(frame);
    const receipt = createRPerformanceLibraryReceipt(decoded);
    const environment = buildRPerformanceChildEnvironment({
      privateRoot,
      sourceEnvironment: { PATH: process.env.PATH, HOME: homedir() },
      libraryReceipt: receipt
    });
    assert.equal(environment.HOME, privateRoot);
    assert.equal(environment.TMPDIR, privateRoot);
    assert.equal(environment.R_LIBS, [userLibrary, siteLibrary, baseLibrary].join(":"));
    assert.equal(environment.R_LIBS_USER, "");
    assert.equal(environment.R_LIBS_SITE, siteLibrary);
    assert.equal(environment.OPEN_WRANGLER_R_PERFORMANCE_LIBRARIES, [userLibrary, siteLibrary, baseLibrary].join(":"));
    assert.equal(environment.OPEN_WRANGLER_R_PERFORMANCE_BASE_LIBRARY, baseLibrary);
    assert.equal(
      environment.OPEN_WRANGLER_R_PERFORMANCE_LIBRARY_PROTOCOL,
      "openwrangler-native-r-library-discovery-v1"
    );
    assert.ok(!Object.values(environment).some((value) => typeof value === "string" && value.includes("sha256")));

    assert.equal(readRPerformanceCallerHomeReceipt({}).path, realpathSync.native(homedir()));
    assert.doesNotThrow(() => preflightRPerformanceLibraryEnvironment({ R_LIBS_USER: "~/R/%p-library/%v" }));
    assert.throws(() => preflightRPerformanceLibraryEnvironment({ R_LIBS: "." }), /relative|unsupported/iu);
    assert.throws(
      () => preflightRPerformanceLibraryEnvironment({ R_LIBS: `${userLibrary}:${userLibrary}` }),
      /duplicate/iu
    );
    for (const name of ["R_LIBS", "R_LIBS_USER", "R_LIBS_SITE"]) {
      assert.throws(
        () => preflightRPerformanceLibraryEnvironment({ [name]: `~/${"x".repeat(64 * 1024)}` }),
        /malformed|oversized/iu,
        name
      );
    }
    assert.throws(
      () => createRPerformanceLibraryReceipt({ ...decoded, libraries: [userLibrary, userLibrary, baseLibrary] }),
      /inconsistent/iu
    );
    const regularFile = join(directory, "not-a-library");
    writeFileSync(regularFile, "sentinel\n", "utf8");
    assert.throws(() => preflightRPerformanceLibraryEnvironment({ R_LIBS: regularFile }), /directory/iu);
    assert.throws(
      () => createRPerformanceLibraryReceipt({ ...decoded, libraries: [regularFile, siteLibrary, baseLibrary] }),
      /directory/iu
    );
    if (platform() !== "win32") {
      const linkedLibrary = join(directory, "linked-library");
      symlinkSync(userLibrary, linkedLibrary, "dir");
      assert.throws(() => preflightRPerformanceLibraryEnvironment({ R_LIBS_USER: linkedLibrary }), /canonical/iu);
      assert.throws(
        () => createRPerformanceLibraryReceipt({ ...decoded, libraries: [linkedLibrary, siteLibrary, baseLibrary] }),
        /canonical/iu
      );
    }
    chmodSync(userLibrary, 0o777);
    assert.throws(() => createRPerformanceLibraryReceipt(decoded), /non-writable-by-others/iu);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("library discovery strict grammar rejects malformed, duplicate, and extra entries", () => {
  assert.throws(() => parseRPerformanceLibraryProbeFrame("unknown\t1\t2f\t0\t2f"), /protocol/iu);
  assert.throws(
    () => parseRPerformanceLibraryProbeFrame("openwrangler-native-r-library-discovery-v1\t1\tzz\t0\t2f"),
    /hexadecimal/iu
  );
  assert.throws(
    () => parseRPerformanceLibraryProbeFrame("openwrangler-native-r-library-discovery-v1\t1\t2f\t0\t2f\textra"),
    /extra/iu
  );
});

test("oversized raw library environment fails before an owned probe spawn", async () => {
  let spawned = false;
  await assert.rejects(
    runRPerformanceLibraryProbe({
      executable: "/ignored/Rscript",
      privateRoot: tmpdir(),
      environment: { HOME: homedir(), R_LIBS_USER: `~/${"x".repeat(64 * 1024)}` },
      spawnProcess() {
        spawned = true;
        throw new Error("spawn must not be reached");
      }
    }),
    /malformed|oversized/iu
  );
  assert.equal(spawned, false);
});

test("direct timing closures exclude harness JSON decode, normalization, and semantic validation", () => {
  const source = readFileSync(join(import.meta.dirname, "r-performance-harness.R"), "utf8");
  assert.doesNotMatch(source, /timed\(function\(\)\s+decode\s*\(/u);
  assert.doesNotMatch(source, /timed\(function\(\)\s+encode\s*\(/u);
  assert.doesNotMatch(source, /timed\(function\(\)\s+validate_(?:page_rows|summary)\s*\(/u);
  assert.match(source, /result <- timed\(function\(\) frame_contract\$materialize_summaries/u);
});

test("CPU model normalization is fixed and keeps the global path ban possible", () => {
  assert.equal(
    normalizeRPerformanceCpuModel("  AMD Ryzen 7 7840U w/ Radeon\\ Graphics  "),
    "AMD Ryzen 7 7840U w Radeon Graphics"
  );
  assert.throws(() => normalizeRPerformanceCpuModel(" / \\ "), /empty/iu);
});

test(
  "output preflight rejects a symlink-parent route to the commit-bound harness",
  { skip: platform() === "win32" },
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-output-test-"));
    try {
      const source = join(directory, "source");
      const scripts = join(source, "scripts");
      const temporary = join(source, "tmp");
      const output = join(directory, "output");
      mkdirSync(scripts, { recursive: true });
      mkdirSync(temporary);
      mkdirSync(output);
      const harness = join(scripts, "r-performance-harness.R");
      writeFileSync(harness, "sentinel harness bytes\n", "utf8");
      symlinkSync("../scripts", join(temporary, "link"), "dir");
      const before = readFileSync(harness);
      assert.throws(
        () => assertSafeOutput(join(temporary, "link", "r-performance-harness.R"), sourceBinding(source, harness)),
        /canonical|alias/iu
      );
      assert.deepEqual(readFileSync(harness), before);

      const accepted = assertSafeOutput(join(output, "report.json"), sourceBinding(source, harness));
      assert.equal(accepted.path, join(output, "report.json"));
      assert.equal(accepted.parentReceipt.path, realpathSync(output));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
);

test("programmatic runner rechecks protected input and output path separation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-separation-test-"));
  try {
    const shared = join(directory, "openwrangler.vsix");
    await assert.rejects(
      runRPerformance({
        candidateInput: shared,
        candidateChecksum: join(directory, "openwrangler.vsix.sha256"),
        candidateProvenance: join(directory, "openwrangler.vsix.provenance.json"),
        output: shared
      }),
      /different|separation|alias/iu
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned Rscript accepts one bounded stdout frame and proves natural group exit", linuxOnly, async () => {
  const child = fakeChild();
  const owned = await spawnOwnedRscript({
    executable: "/ignored/Rscript",
    arguments_: [],
    privateRoot: tmpdir(),
    spawnImpl: () => child,
    readRss: () => 1024
  });
  owned.beginStage();
  const linePromise = owned.nextLine();
  child.stdout.write('{"ok":true}\n');
  assert.equal((await linePromise).text, '{"ok":true}');
  assert.equal(owned.endStage(), 1024);
  owned.endInput();
  emitClosed(child);
  await owned.waitNaturalExit();
  assert.equal(owned.naturallyExited, true);
  assert.ok(owned.rssObservations > 0);
});

test("owned Rscript rejects unsolicited stdout-frame floods", linuxOnly, async () => {
  const child = fakeChild();
  const owned = await spawnOwnedRscript({
    executable: "/ignored/Rscript",
    arguments_: [],
    privateRoot: tmpdir(),
    spawnImpl: () => child,
    readRss: () => 1024
  });
  child.stdout.write('{"first":1}\n{"extra":2}\n');
  await assert.rejects(owned.nextLine(), /unsolicited extra/iu);
  emitClosed(child);
  await owned.terminate();
});

test("owned Rscript latches stdin EPIPE and stderr errors without raw diagnostics", linuxOnly, async () => {
  const child = fakeChild();
  const owned = await spawnOwnedRscript({
    executable: "/ignored/Rscript",
    arguments_: [],
    privateRoot: tmpdir(),
    spawnImpl: () => child,
    readRss: () => 1024
  });
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    child.stdin.destroy(Object.assign(new Error("secret /home/alice"), { code: "EPIPE" }));
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(owned.writeJson({ request: true }), /stdin/iu);
    child.stderr.destroy(new Error("secret /home/alice"));
    emitClosed(child);
    await assert.rejects(owned.waitNaturalExit(), /stdin|stderr stream/iu);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await owned.terminate();
  }
});

test("correlated write failure owns the abandoned response rejection", async () => {
  let rejectResponse;
  const child = {
    beginStage() {},
    endStage() {
      return 1;
    },
    nextLine() {
      return new Promise((_, reject) => {
        rejectResponse = reject;
      });
    },
    async writeJson() {
      throw new Error("fixed write failure");
    }
  };
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(
      sendCorrelated(child, { kind: "getPage" }, () => {}),
      /fixed write failure/iu
    );
    rejectResponse(new Error("late response close"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("spawn errors, malformed stdio, and RSS sampler faults remain orchestrated", linuxOnly, async () => {
  const asyncFailure = fakeChild({ pid: null });
  await assert.rejects(
    spawnOwnedRscript({
      executable: "/missing/Rscript",
      arguments_: [],
      privateRoot: tmpdir(),
      spawnImpl: () => asyncFailure,
      readRss: () => 1
    }),
    /own one Rscript/iu
  );
  assert.doesNotThrow(() => asyncFailure.emit("error", new Error("ENOENT /private/path")));

  const malformed = fakeChild({ stdout: {} });
  await assert.rejects(
    spawnOwnedRscript({
      executable: "/ignored/Rscript",
      arguments_: [],
      privateRoot: tmpdir(),
      spawnImpl: () => malformed,
      readRss: () => 1
    }),
    /own one Rscript/iu
  );

  const uncertain = fakeChild({ stdout: {} });
  await assert.rejects(
    spawnOwnedRscript({
      executable: "/ignored/Rscript",
      arguments_: [],
      privateRoot: tmpdir(),
      spawnImpl: () => uncertain,
      readRss: () => 1,
      probeProcessGroup() {
        throw Object.assign(new Error("injected process-group probe fault"), { code: "EPERM" });
      }
    }),
    (error) => error?.code === "OPEN_WRANGLER_R_PERFORMANCE_OWNERSHIP_UNCERTAIN"
  );

  const sampled = fakeChild();
  const owned = await spawnOwnedRscript({
    executable: "/ignored/Rscript",
    arguments_: [],
    privateRoot: tmpdir(),
    spawnImpl: () => sampled,
    readRss() {
      throw new Error("injected proc read failure");
    }
  });
  owned.beginStage();
  assert.throws(() => owned.endStage(), /sampler failed/iu);
  emitClosed(sampled);
  await owned.terminate();
});

test("private asset writer permits only its own size transition and rejects path substitution", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-private-writer-test-"));
  try {
    const expected = Buffer.from("exact private bytes\n", "utf8");
    const receipt = writeRPerformancePrivateFile(directory, "accepted.R", expected);
    assert.deepEqual(receipt.bytes, expected);

    const displaced = join(directory, "displaced.R");
    assert.throws(
      () =>
        writeRPerformancePrivateFile(directory, "substituted.R", expected, {
          afterWrite(path) {
            renameSync(path, displaced);
            writeFileSync(path, "replacement\n", "utf8");
          }
        }),
      /path changed/iu
    );
    assert.deepEqual(readFileSync(displaced), expected);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function directHarnessResult() {
  return {
    protocol: "openwrangler-native-r-performance-harness-v1",
    kind: "direct",
    runtime: {
      rVersion: "4.5.1",
      platform: "x86_64-pc-linux-gnu",
      architecture: "x86_64",
      operatingSystem: "Linux",
      libraryResolution: {
        protocol: "openwrangler-native-r-library-discovery-v1",
        directoryCount: 4,
        explicitDirectoriesVerified: true
      },
      packages: {
        jsonlite: "2.0.0",
        dataTable: "1.17.8",
        rlang: "1.1.6",
        bit64: "4.6.0-1",
        tibble: null,
        nanoparquet: null,
        collapse: null
      }
    },
    fixture: structuredClone(R_PERFORMANCE_FIXTURE_DEFINITION),
    freshOpenSamplesMs: [1, 2, 3, 4, 5],
    projectedPageSamplesMs: Array.from({ length: 20 }, (_, index) => index + 1),
    compoundFilterPageSamplesMs: Array.from({ length: 20 }, (_, index) => index + 21),
    stableMultiKeySortFirstUncachedMs: 50,
    stableMultiKeySortPageSamplesMs: Array.from({ length: 20 }, (_, index) => index + 51),
    eightColumnSummarySamplesMs: Array.from({ length: 20 }, (_, index) => index + 71),
    resourceProof: {
      processVmHwmKiB: 600,
      stageVmHwmKiB: {
        freshOpen: 100,
        projectedPage: 200,
        compoundFilterPage: 300,
        stableMultiKeySortPage: 400,
        eightColumnSummary: 500,
        semanticProof: 600
      }
    },
    semanticProof: {
      passed: true,
      sourceUnchanged: true,
      freshPagesVerified: 5,
      projectedPagesVerified: 20,
      compoundFilterPagesVerified: 20,
      stableSortPagesVerified: 20,
      summariesVerified: 20,
      datasetStatsVerified: true,
      millionRowSampledSummaryVerified: true,
      keyedDataTableVerified: true
    }
  };
}

test("full orchestration publishes from the same receipts and removes its private root", linuxOnly, async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-performance-orchestration-test-"));
  try {
    const sourceRoot = join(directory, "source");
    const scripts = join(sourceRoot, "scripts");
    const artifactRoot = join(directory, "artifacts");
    const outputRoot = join(directory, "output");
    mkdirSync(scripts, { recursive: true });
    mkdirSync(artifactRoot);
    mkdirSync(outputRoot);
    const harnessPath = join(scripts, "r-performance-harness.R");
    const harnessBytes = Buffer.from("deterministic harness fixture\n", "utf8");
    writeFileSync(harnessPath, harnessBytes);
    const harnessMetadata = lstatSync(harnessPath, { bigint: true });
    const commit = "1".repeat(40);
    const sourceReceipt = Object.freeze({
      root: realpathSync.native(sourceRoot),
      commit,
      releaseTag: "v1.2.3",
      harnessPath,
      harnessSha256: createHash("sha256").update(harnessBytes).digest("hex"),
      harness: Object.freeze({
        bytes: harnessBytes,
        identity: Object.freeze({ dev: harnessMetadata.dev, ino: harnessMetadata.ino })
      })
    });
    const options = {
      candidateInput: join(artifactRoot, "openwrangler.vsix"),
      candidateChecksum: join(artifactRoot, "openwrangler.vsix.sha256"),
      candidateProvenance: join(artifactRoot, "openwrangler.vsix.provenance.json"),
      output: join(outputRoot, "native-r-performance.json")
    };
    const candidateBytes = Buffer.from("candidate receipt bytes\n", "utf8");
    const frameBytes = Buffer.from("frame contract fixture\n", "utf8");
    const kernelBytes = Buffer.from("kernel agent fixture\n", "utf8");
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    let acceptedIntake;
    let privateCandidatePath;
    let privateRootPath;
    const order = [];
    const contexts = [];
    const revalidationCounts = { source: 0, candidate: 0, publicCandidate: 0, node: 0, rscript: 0, library: 0 };
    const nodeReceipt = Object.freeze({
      path: "/test/node",
      bytes: Buffer.from("node"),
      sha256: digest(Buffer.from("node"))
    });
    const rscriptReceipt = Object.freeze({
      path: "/test/Rscript",
      bytes: Buffer.from("rscript"),
      sha256: digest(Buffer.from("rscript"))
    });
    const libraryReceipt = Object.freeze({ libraries: Object.freeze(["one", "two", "three", "four"]) });
    const runtime = directHarnessResult().runtime;
    const freshDurations = [];

    const result = await runRPerformance(options, {
      environment: { EXPECTED_SHA: commit, RELEASE_TAG: "v1.2.3", HOME: homedir(), PATH: process.env.PATH },
      now: () => new Date("2026-08-15T12:00:00.000Z"),
      nodeReceipt,
      rscriptReceipt,
      readSourceBinding() {
        return sourceReceipt;
      },
      async acceptPerformanceCandidate({ privateCandidatePath: destination }) {
        privateCandidatePath = destination;
        writeFileSync(destination, candidateBytes);
        acceptedIntake = Object.freeze({
          candidate: Object.freeze({
            artifactKind: "performance-evidence",
            extensionId: "Matt17BR.openwrangler",
            extensionVersion: "1.2.3",
            preview: false,
            releaseTag: "v1.2.3",
            sourceCommit: commit,
            vsixSha256: digest(candidateBytes),
            vsixBytes: candidateBytes.length,
            checksumSha256: "2".repeat(64),
            provenanceProtocol: "openwrangler-performance-evidence-artifact-v1",
            provenanceSha256: "3".repeat(64)
          }),
          extracted: Object.freeze({
            frameContract: Object.freeze({
              name: "frame_contract.R",
              bytes: frameBytes,
              sha256: digest(frameBytes)
            }),
            kernelAgent: Object.freeze({ name: "kernel_agent.R", bytes: kernelBytes, sha256: digest(kernelBytes) })
          })
        });
        return acceptedIntake;
      },
      revalidateSourceReceipt(receipt) {
        revalidationCounts.source += 1;
        assert.equal(receipt, sourceReceipt);
        assert.deepEqual(readFileSync(harnessPath), harnessBytes);
      },
      revalidateCandidateReceipt(receipt) {
        revalidationCounts.candidate += 1;
        assert.equal(receipt, acceptedIntake);
        assert.deepEqual(readFileSync(privateCandidatePath), candidateBytes);
      },
      revalidatePublicCandidateReceipt(receipt) {
        revalidationCounts.publicCandidate += 1;
        assert.equal(receipt, acceptedIntake);
      },
      revalidateNodeReceipt(receipt) {
        revalidationCounts.node += 1;
        assert.equal(receipt, nodeReceipt);
      },
      revalidateRscriptReceipt(receipt) {
        revalidationCounts.rscript += 1;
        assert.equal(receipt, rscriptReceipt);
      },
      revalidateLibraryReceipt(receipt) {
        revalidationCounts.library += 1;
        assert.equal(receipt, libraryReceipt);
      },
      async runLibraryProbe(context) {
        order.push("library-probe");
        contexts.push(context);
        privateRootPath = context.privateRoot.root;
        return { receipt: libraryReceipt, maxObservedRssKiB: 80, exitedNaturally: true };
      },
      async runDirectMeasurement(context) {
        order.push("direct");
        contexts.push(context);
        const value = directHarnessResult();
        return { value, runtime, parentMaxObservedRssKiB: 700, exitedNaturally: true };
      },
      async runFreshMeasurement(context) {
        order.push("fresh");
        contexts.push(context);
        const durationMs = freshDurations.length + 10;
        freshDurations.push(durationMs);
        return {
          durationMs,
          maxObservedRssKiB: 200 + freshDurations.length,
          runtime,
          exitedNaturally: true,
          correlatedResponses: 2,
          closedSessions: 1,
          readyFrames: 1
        };
      },
      async runWorkloadMeasurement(context) {
        order.push("workload");
        contexts.push(context);
        const twenty = Array.from({ length: 20 }, (_, index) => index + 1);
        const rss = twenty.map((value) => value + 300);
        return {
          runtime,
          exitedNaturally: true,
          projectedPageSamplesMs: twenty,
          compoundFilterPageSamplesMs: twenty.map((value) => value + 20),
          stableMultiKeySortFirstUncachedMs: 50,
          stableMultiKeySortPageSamplesMs: twenty.map((value) => value + 40),
          eightColumnSummarySamplesMs: twenty.map((value) => value + 60),
          resources: {
            maxObservedRssKiB: 1_000,
            projectedPage: rss,
            compoundFilterPage: rss,
            stableMultiKeySortFirstUncached: 400,
            stableMultiKeySortPage: rss,
            eightColumnSummary: rss,
            semanticControls: 500
          },
          correlatedResponses: 89,
          closedSessions: 3,
          readyFrames: 1
        };
      }
    });

    assert.deepEqual(order, ["library-probe", "direct", "fresh", "fresh", "fresh", "fresh", "fresh", "workload"]);
    assert.equal(new Set(contexts.map((context) => context.sourceBinding)).size, 1);
    assert.equal(new Set(contexts.map((context) => context.intake)).size, 1);
    assert.equal(new Set(contexts.map((context) => context.outputBinding)).size, 1);
    assert.equal(contexts[0].libraryReceipt, undefined);
    assert.ok(contexts.slice(1).every((context) => context.libraryReceipt === libraryReceipt));
    assert.equal(result.report.measurements.kernelRoundTrip.semanticProof.responseAccounting.allTotal, 99);
    assert.equal(result.report.measurements.kernelRoundTrip.semanticProof.responseAccounting.measuredTotal, 86);
    assert.equal(result.report.cleanup.sessionsClosed, 8);
    assert.equal(result.report.cleanup.ownedRscriptProcessesExitedNaturally, 8);
    assert.equal(result.report.measurementValid.passed, true);
    assert.equal(result.report.releaseGate.passed, false);
    assert.equal(existsSync(options.output), true);
    assert.equal(result.receipt.bytes, readFileSync(options.output).length);
    assert.equal(existsSync(privateRootPath), false);
    for (const [name, count] of Object.entries(revalidationCounts)) {
      assert.ok(count >= 2, `${name} receipt was not revalidated across orchestration`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("direct harness validation rejects sample, runtime, resource, and semantic substitution", () => {
  const accepted = validateRPerformanceDirectFrame(directHarnessResult());
  assert.equal(accepted.kind, "direct");
  assert.equal(assertRuntimeMatchesLibraryReceipt(accepted.runtime, { libraries: [1, 2, 3, 4] }), accepted.runtime);
  assert.throws(
    () => assertRuntimeMatchesLibraryReceipt(accepted.runtime, { libraries: [1, 2, 3] }),
    /private discovery receipt/iu
  );
  const cases = [
    (value) => value.freshOpenSamplesMs.pop(),
    (value) => {
      value.runtime.packages.bit64 = null;
    },
    (value) => {
      value.resourceProof.processVmHwmKiB = 1;
    },
    (value) => {
      value.semanticProof.datasetStatsVerified = false;
    }
  ];
  for (const mutate of cases) {
    const value = directHarnessResult();
    mutate(value);
    assert.throws(() => validateRPerformanceDirectFrame(value), /invalid|requires?|VmHWM|incomplete/iu);
  }
});

function kernelRequestFixture(kind = "getSummary") {
  return {
    transportVersion: 14,
    requestId: "11111111-1111-4111-8111-111111111111",
    kind,
    payload: { sessionId: "22222222-2222-4222-8222-222222222222" }
  };
}

function mixedSummaryResponse(request) {
  const positions = [2, 3, 4, 7, 9, 10, 11, 12];
  const rawTypes = ["double", "character", "logical", "factor", "Date", "POSIXct", "difftime", "integer64"];
  const types = ["float", "string", "boolean", "string", "date", "datetime", "duration", "integer"];
  const summaries = positions.map((position, index) => ({
    columnId: `r:c:${position}`,
    column: R_PERFORMANCE_FIXTURE_DEFINITION.profileColumns[index],
    totalCount: 250_000,
    rawType: rawTypes[index],
    type: types[index]
  }));
  Object.assign(summaries[0], { nullCount: 250, nanCount: 321 });
  Object.assign(summaries[1], { nullCount: 497, text: { minLength: 7, maxLength: 10 } });
  Object.assign(summaries[2], {
    nullCount: 491,
    visualization: { trueCount: 124_755, falseCount: 124_754 }
  });
  summaries[4].visualization = { min: "2020-01-01", max: "2023-12-31" };
  summaries[5].visualization = {
    min: "2020-01-01T00:00:00.000000",
    max: "2020-01-02T03:46:39.000000"
  };
  summaries[6].numeric = { min: 0, max: 7199 };
  summaries[7].numeric = {
    exactMin: { raw: "9007199254740993" },
    exactMax: { raw: "9007199254990992" }
  };
  return {
    transportVersion: 14,
    requestId: request.requestId,
    kind: "summary",
    sessionId: request.payload.sessionId,
    summaries
  };
}

test("kernel correlation and mixed-summary semantics fail closed", () => {
  const request = kernelRequestFixture();
  const response = mixedSummaryResponse(request);
  assert.doesNotThrow(() => validateSummaryResponse(response, request));
  const semanticDrift = structuredClone(response);
  semanticDrift.summaries[2].visualization.trueCount -= 1;
  assert.throws(() => validateSummaryResponse(semanticDrift, request), /counts|sentinels|mixed-type/iu);

  const closedRequest = kernelRequestFixture("closeSession");
  const closed = {
    transportVersion: 14,
    requestId: closedRequest.requestId,
    kind: "closed",
    sessionId: closedRequest.payload.sessionId
  };
  assert.doesNotThrow(() => validateClosedResponse(closed, closedRequest));
  assert.throws(
    () => validateClosedResponse({ ...closed, requestId: "33333333-3333-4333-8333-333333333333" }, closedRequest),
    /correlation/iu
  );
  assert.throws(() => validateClosedResponse({ ...closed, extra: true }, closedRequest), /unknown fields/iu);
});

test("strict correlated timing rejects response-before-write and duplicate-key frames", async () => {
  const request = { kind: "getPage" };
  const child = {
    beginStage() {},
    endStage() {
      return 1;
    },
    nextLine() {
      return Promise.resolve({ text: "{}", arrivedAt: performance.now() });
    },
    writeJson() {
      return Promise.resolve(performance.now() + 1000);
    }
  };
  await assert.rejects(
    sendCorrelated(child, request, () => {}),
    /arrived before/iu
  );

  const duplicate = {
    ...child,
    nextLine() {
      return Promise.resolve({ text: '{"kind":"page","kind":"page"}', arrivedAt: performance.now() + 10 });
    },
    writeJson() {
      return Promise.resolve(performance.now());
    }
  };
  await assert.rejects(
    sendCorrelated(duplicate, request, () => {}),
    /duplicate/iu
  );
});

test("one absolute owned-process deadline is not renewed by later reads", linuxOnly, async () => {
  const child = fakeChild();
  const owned = await spawnOwnedRscript({
    executable: "/ignored/Rscript",
    arguments_: [],
    privateRoot: tmpdir(),
    spawnImpl: () => child,
    readRss: () => 1024,
    processDeadlineMs: 80
  });
  await new Promise((resolve) => setTimeout(resolve, 65));
  const started = performance.now();
  await assert.rejects(owned.nextLine(), /deadline/iu);
  assert.ok(performance.now() - started < 45, "the read incorrectly received a fresh 80ms deadline");
  emitClosed(child);
  await owned.terminate();
});

function datasetStatsResponse(request) {
  return {
    transportVersion: 14,
    requestId: request.requestId,
    kind: "datasetStats",
    sessionId: request.payload.sessionId,
    totalRows: 250_000,
    stats: {
      missingCells: 4848,
      missingRows: 4824,
      duplicateRows: 0,
      duplicateRowsSampleSize: 100_000,
      missingValuesByColumn: R_PERFORMANCE_FIXTURE_DEFINITION.columnDefinitions.map((column, index) => ({
        column: column.name,
        count: R_PERFORMANCE_FIXTURE_DEFINITION.expectedStats.missingValuesByColumn[index]
      }))
    }
  };
}

test("dataset stats and million-row controls validate exact semantics", () => {
  const statsRequest = kernelRequestFixture("getDatasetStats");
  const stats = datasetStatsResponse(statsRequest);
  assert.doesNotThrow(() => validateDatasetStatsResponse(stats, statsRequest));
  const drift = structuredClone(stats);
  drift.stats.missingValuesByColumn[6].count += 1;
  assert.throws(() => validateDatasetStatsResponse(drift, statsRequest), /distribution/iu);

  const openRequest = kernelRequestFixture("openSession");
  const open = {
    transportVersion: 14,
    requestId: openRequest.requestId,
    kind: "page",
    sessionId: openRequest.payload.sessionId,
    exportFormats: ["csv", "parquet"],
    page: {
      contractVersion: 5,
      dataframeFlavor: "r.data.frame",
      shape: { rows: 1_000_001, columns: 1 },
      schema: [{ id: "r:c:0", name: "value" }],
      page: { totalRows: 1_000_001, rows: [{}] }
    }
  };
  assert.doesNotThrow(() => validateLargeOpenResponse(open, openRequest));
  const summaryRequest = kernelRequestFixture("getSummary");
  const summary = {
    transportVersion: 14,
    requestId: summaryRequest.requestId,
    kind: "summary",
    sessionId: summaryRequest.payload.sessionId,
    summaries: [
      {
        columnId: "r:c:0",
        totalCount: 1_000_001,
        visualization: { sampled: true },
        numeric: { min: 0, max: 999 }
      }
    ]
  };
  assert.doesNotThrow(() => validateLargeSummaryResponse(summary, summaryRequest));
  summary.summaries[0].visualization.sampled = false;
  assert.throws(() => validateLargeSummaryResponse(summary, summaryRequest), /sampled summary/iu);
});
