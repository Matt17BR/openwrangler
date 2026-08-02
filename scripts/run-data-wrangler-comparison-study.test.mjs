import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  buildDataWranglerStudyManifest,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue,
  inspectDataWranglerStudyTrialIntents,
  validateDataWranglerStudyFragment
} from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
  PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
  PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
  PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
  createDataWranglerPolarsCapabilityReceipt,
  createExpectedPublicUiExtensionInventory,
  createNeitherProductControlReceipt,
  createPublicUiReceiptContext
} from "./data-wrangler-public-ui-receipts.mjs";
import {
  DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL,
  createManifestBoundDataWranglerPolarsUnsupportedFragment,
  dataWranglerStudyExecutionLockPath,
  manifestDeclaresDataWranglerPolarsUnavailable,
  parseDataWranglerComparisonStudyArguments,
  runNextDataWranglerComparisonStudyTrial,
  runDataWranglerComparisonStudy
} from "./run-data-wrangler-comparison-study.mjs";

const digest = (value) => value.repeat(64);

test("study command arguments are explicit and reject missing or repeated paths", () => {
  assert.deepEqual(
    parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json", "--out", "manifest.json"], "/work"),
    { command: "plan", spec: "/work/spec.json", out: "/work/manifest.json" }
  );
  assert.throws(
    () => parseDataWranglerComparisonStudyArguments(["plan", "--spec", "spec.json"], "/work"),
    /requires --out/u
  );
  assert.throws(
    () =>
      parseDataWranglerComparisonStudyArguments(
        ["status", "--manifest", "one.json", "--manifest", "two.json", "--fragments", "fragments"],
        "/work"
      ),
    /only once/u
  );
  assert.throws(() => parseDataWranglerComparisonStudyArguments(["launch"], "/work"), /Usage/u);
  for (const selector of ["--product", "--engine", "--format"]) {
    assert.throws(
      () =>
        parseDataWranglerComparisonStudyArguments(
          ["status", "--manifest", "manifest.json", "--fragments", "fragments", selector, "forbidden"],
          "/work"
        ),
      /Unknown or incomplete study argument/u
    );
  }
});

test("CLI specification and fragment inputs reject symlinks and directory-entry swaps", async (t) => {
  await t.test("specification symlink", () => {
    withDirectory((directory) => {
      const realSpecification = resolve(directory, "real-spec.json");
      const linkedSpecification = resolve(directory, "spec.json");
      writeFileSync(realSpecification, JSON.stringify(studySpecification()));
      symlinkSync(realSpecification, linkedSpecification);
      assert.throws(
        () =>
          runDataWranglerComparisonStudy(
            ["plan", "--spec", linkedSpecification, "--out", resolve(directory, "manifest.json")],
            { cwd: directory }
          ),
        /bounded, singly linked regular JSON file/u
      );
    });
  });

  await t.test("specification entry swap", () => {
    withDirectory((directory) => {
      const specification = resolve(directory, "spec.json");
      const displaced = resolve(directory, "spec-displaced.json");
      writeFileSync(specification, JSON.stringify(studySpecification()));
      assert.throws(
        () =>
          runDataWranglerComparisonStudy(
            ["plan", "--spec", specification, "--out", resolve(directory, "manifest.json")],
            {
              cwd: directory,
              inputReadOptions: {
                faultInjector: (point, label) => {
                  if (point === "file-opened" && label === "Study specification") {
                    renameSync(specification, displaced);
                    writeFileSync(specification, JSON.stringify(studySpecification()));
                  }
                }
              }
            }
          ),
        /Study specification changed while it was read/u
      );
    });
  });

  for (const mode of ["symlink", "entry swap"]) {
    await t.test(`fragment ${mode}`, () => {
      withDirectory((directory) => {
        const specification = resolve(directory, "spec.json");
        const manifest = resolve(directory, "manifest.json");
        const realFragment = resolve(directory, "real-fragment.json");
        const fragment = resolve(directory, "fragment.json");
        writeFileSync(specification, JSON.stringify(studySpecification()));
        runDataWranglerComparisonStudy(["plan", "--spec", specification, "--out", manifest], { cwd: directory });
        writeFileSync(realFragment, "{}\n");
        if (mode === "symlink") {
          symlinkSync(realFragment, fragment);
        } else {
          renameSync(realFragment, fragment);
        }
        const inputReadOptions =
          mode === "entry swap"
            ? {
                faultInjector: (point, label) => {
                  if (point === "file-opened" && label === "Study fragment input") {
                    renameSync(fragment, realFragment);
                    writeFileSync(fragment, "{}\n");
                  }
                }
              }
            : {};
        assert.throws(
          () =>
            runDataWranglerComparisonStudy(
              [
                "record",
                "--manifest",
                manifest,
                "--fragments",
                resolve(directory, "fragments"),
                "--fragment",
                fragment
              ],
              { cwd: directory, inputReadOptions }
            ),
          mode === "symlink"
            ? /bounded, singly linked regular JSON file/u
            : /Study fragment input changed while it was read/u
        );
      });
    });
  }
});

test("plan, record, and status preserve one immutable manifest and append-only fragment", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const fragmentInputPath = resolve(directory, "fragment-input.json");
    const fragments = resolve(directory, "fragments");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));

    const planned = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
      cwd: directory
    });
    assert.equal(planned.output.schedule.length, 96);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).studyId, planned.output.studyId);
    const repeatedPlan = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
      cwd: directory
    });
    assert.deepEqual(repeatedPlan.output, planned.output);
    assert.equal(repeatedPlan.receipt.status, "complete");
    assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);

    const entry = planned.output.schedule[0];
    const fragment = {
      ...createStudyFragmentIdentity({
        manifest: planned.output,
        scheduleEntry: entry,
        executionIndex: 0,
        recordedAtUtc: "2026-08-02T11:00:00.000Z"
      }),
      outcome: {
        status: "pre-action-invalid",
        reasonClass: "setup",
        actionStarted: false,
        correctness: "not-reached",
        timeout: null,
        unsupported: null
      },
      milestones: createEmptyStudyMilestones(),
      cacheProof: null,
      engineEvidence: null,
      environmentGate: failedEnvironmentGate(planned.output),
      sourceLoad: { status: "not-reached", durationMs: null, includedInInlineTiming: false },
      uiEvidence: null,
      processProofs: null,
      resourceObservation: null,
      cleanupProof: null,
      trialProvenance: null
    };
    writeFileSync(fragmentInputPath, JSON.stringify(fragment));
    const recorded = runDataWranglerComparisonStudy(
      ["record", "--manifest", manifestPath, "--fragments", fragments, "--fragment", fragmentInputPath],
      { cwd: directory }
    );
    assert.equal(recorded.output.fragmentId, fragment.fragmentId);
    const repeatedRecord = runDataWranglerComparisonStudy(
      ["record", "--manifest", manifestPath, "--fragments", fragments, "--fragment", fragmentInputPath],
      { cwd: directory }
    );
    assert.deepEqual(repeatedRecord.output, recorded.output);
    assert.equal(repeatedRecord.receipt.status, "complete");
    const status = runDataWranglerComparisonStudy(["status", "--manifest", manifestPath, "--fragments", fragments], {
      cwd: directory
    });
    assert.equal(status.output.fragmentCount, 1);
    assert.equal(status.output.pendingCount, 96);
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(
          ["finalize", "--manifest", manifestPath, "--fragments", fragments, "--out", "result.json"],
          { cwd: directory }
        ),
      /planned pair work remains/u
    );
  });
});

test("plan recovers an exact linked publication and creates only a private output directory", () => {
  withDirectory((directory) => {
    const studyDirectory = resolve(directory, "study");
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(studyDirectory, "manifest.json");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));

    assert.throws(
      () =>
        runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
          cwd: directory,
          publicationOptions: {
            manifest: {
              faultInjector: (point) => {
                if (point === "target-linked") {
                  throw new Error("injected manifest link crash");
                }
              },
              tokenFactory: () => "1".repeat(32)
            }
          }
        }),
      /injected manifest link crash/u
    );

    assert.equal(lstatSync(studyDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(manifestPath).nlink, 2);
    const recovered = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
      cwd: directory
    });
    assert.equal(recovered.receipt.status, "recovered");
    assert.equal(lstatSync(manifestPath).nlink, 1);
    assert.equal(lstatSync(manifestPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), recovered.output);
  });
});

test("run-next selects only pending zero, publishes one fragment, and reloads a retry attempt", async () => {
  await withDirectory(async (directory) => {
    const paths = planStudy(directory);
    const observed = [];
    const executeTrial = async ({ manifest, scheduleEntry, executionIndex }) => {
      observed.push({ id: scheduleEntry.id, attempt: scheduleEntry.attempt, executionIndex });
      return preActionInvalidFragment(manifest, scheduleEntry, executionIndex);
    };

    const first = await runNextDataWranglerComparisonStudyTrial(paths, { executeTrial });
    assert.equal(first.status, "recorded");
    assert.equal(first.output.executionIndex, 0);
    assert.equal(first.output.scheduleEntryId, observed[0].id);
    assert.deepEqual(observed[0], {
      id: first.output.scheduleEntryId,
      attempt: 0,
      executionIndex: 0
    });

    const firstStatus = runDataWranglerComparisonStudy(
      ["status", "--manifest", paths.manifestPath, "--fragments", paths.fragmentsDirectory],
      { cwd: directory }
    );
    assert.equal(firstStatus.output.fragmentCount, 1);
    assert.equal(firstStatus.output.pending[0].id, observed[0].id);
    assert.equal(firstStatus.output.pending[0].attempt, 1);

    const second = await runNextDataWranglerComparisonStudyTrial(paths, { executeTrial });
    assert.equal(second.output.executionIndex, 1);
    assert.deepEqual(observed[1], { id: observed[0].id, attempt: 1, executionIndex: 1 });
    const secondStatus = runDataWranglerComparisonStudy(
      ["status", "--manifest", paths.manifestPath, "--fragments", paths.fragmentsDirectory],
      { cwd: directory }
    );
    assert.equal(secondStatus.output.fragmentCount, 2);
    assert.equal(secondStatus.output.pending[0].id, observed[0].id);
    assert.equal(secondStatus.output.pending[0].attempt, 2);
    assert.equal(existsSync(dataWranglerStudyExecutionLockPath(paths.manifestPath)), false);
  });
});

test("run-next keeps one exclusive Linux execution owner across asynchronous trial work", async () => {
  await withDirectory(async (directory) => {
    const paths = planStudy(directory);
    let releaseTrial;
    let markStarted;
    const started = new Promise((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const held = new Promise((resolveHeld) => {
      releaseTrial = resolveHeld;
    });
    const first = runNextDataWranglerComparisonStudyTrial(paths, {
      executeTrial: async ({ manifest, scheduleEntry, executionIndex }) => {
        markStarted();
        await held;
        return preActionInvalidFragment(manifest, scheduleEntry, executionIndex);
      }
    });
    await started;
    let contenderInvoked = false;
    await assert.rejects(
      runNextDataWranglerComparisonStudyTrial(paths, {
        executeTrial: async () => {
          contenderInvoked = true;
          throw new Error("contender must not execute");
        }
      }),
      /already owns the Linux execution lock/u
    );
    assert.equal(contenderInvoked, false);
    releaseTrial();
    await first;
  });
});

test("run-next recovers only a proven-dead exact Linux lock owner", async (t) => {
  await t.test("owner from a prior boot", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      const current = currentLinuxLockOwner();
      const priorBootId = `${current.bootId.startsWith("0") ? "1" : "0"}${current.bootId.slice(1)}`;
      writeExecutionLock(paths.manifestPath, {
        ...current,
        bootId: priorBootId
      });
      const result = await runNextDataWranglerComparisonStudyTrial(paths, {
        executeTrial: async ({ manifest, scheduleEntry, executionIndex }) =>
          preActionInvalidFragment(manifest, scheduleEntry, executionIndex)
      });
      assert.equal(result.status, "recorded");
      assert.equal(existsSync(dataWranglerStudyExecutionLockPath(paths.manifestPath)), false);
    });
  });

  await t.test("absent exact PID on the current boot", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      const current = currentLinuxLockOwner();
      writeExecutionLock(paths.manifestPath, { ...current, pid: 2_147_483_647, startTimeTicks: "1" });
      const result = await runNextDataWranglerComparisonStudyTrial(paths, {
        executeTrial: async ({ manifest, scheduleEntry, executionIndex }) =>
          preActionInvalidFragment(manifest, scheduleEntry, executionIndex)
      });
      assert.equal(result.status, "recorded");
    });
  });
});

test("run-next fails closed for a live or ambiguous durable lock owner", async (t) => {
  await t.test("live exact PID and start time", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      writeExecutionLock(paths.manifestPath, currentLinuxLockOwner());
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async () => assert.fail("live-lock contender executed")
        }),
        new RegExp(`PID ${process.pid} with start time`, "u")
      );
      assert.equal(existsSync(dataWranglerStudyExecutionLockPath(paths.manifestPath)), true);
    });
  });

  await t.test("malformed owner record", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      writeFileSync(dataWranglerStudyExecutionLockPath(paths.manifestPath), "{}\n", { mode: 0o600 });
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async () => assert.fail("ambiguous-lock contender executed")
        }),
        /ownership is ambiguous/u
      );
      assert.equal(existsSync(dataWranglerStudyExecutionLockPath(paths.manifestPath)), true);
    });
  });
});

test("run-next retries a pre-authorization crash and halts after a post-authorization crash", async (t) => {
  await t.test("pre-authorization crash", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      let lateAuthorize;
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async ({ authorizeAction }) => {
            lateAuthorize = authorizeAction;
            throw new Error("injected pre-authorization crash");
          }
        }),
        /injected pre-authorization crash/u
      );
      assert.throws(lateAuthorize, /no longer available/u);
      const retried = await runNextDataWranglerComparisonStudyTrial(paths, {
        executeTrial: async ({ manifest, scheduleEntry, executionIndex }) =>
          preActionInvalidFragment(manifest, scheduleEntry, executionIndex)
      });
      assert.equal(retried.output.attempt, 0);
      const inspection = inspectDataWranglerStudyTrialIntents({
        directory: paths.intentsDirectory,
        manifest: paths.manifest,
        fragments: [retried.output]
      });
      assert.equal(inspection.authorizedCount, 0);
      assert.equal(inspection.abandonedPreparedCount, 2);
    });
  });

  await t.test("post-authorization crash", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async ({ authorizeAction }) => {
            authorizeAction();
            throw new Error("injected post-authorization crash");
          }
        }),
        /injected post-authorization crash/u
      );
      let retried = false;
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async () => {
            retried = true;
            throw new Error("must remain blocked");
          }
        }),
        /authorized action without a published result/u
      );
      assert.equal(retried, false);
    });
  });
});

test("manifest-declared Data Wrangler Polars unavailability produces a launch-free fragment", () => {
  const manifest = runDataWranglerComparisonStudyManifest("unavailable");
  const unavailableEntry = manifest.schedule.find(
    (entry) => entry.product === "data-wrangler" && entry.engine === "polars"
  );
  const scheduleEntry = {
    ...unavailableEntry,
    attempt: 0,
    effectiveBlockId: `${unavailableEntry.blockId}~a00`
  };
  const fragment = createManifestBoundDataWranglerPolarsUnsupportedFragment({
    manifest,
    scheduleEntry,
    executionIndex: scheduleEntry.sequence,
    recordedAtUtc: "2026-08-02T11:00:00.000Z",
    fragmentId: "44444444-4444-4444-8444-444444444444"
  });
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);
  assert.equal(fragment.outcome.status, "unsupported");
  assert.equal(fragment.outcome.actionStarted, false);
  assert.equal(fragment.processProofs, null);
  assert.equal(fragment.resourceObservation, null);
  assert.equal(fragment.cleanupProof, null);
});

test("Data Wrangler Polars availability is matched to the scheduled file format", () => {
  for (const [availability, expectedCsv, expectedParquet] of [
    [{ "csv-100k-50": "available", "parquet-1m-20": "unavailable" }, false, true],
    [{ "csv-100k-50": "unavailable", "parquet-1m-20": "available" }, true, false]
  ]) {
    const manifest = runDataWranglerComparisonStudyManifest(availability);
    const csvEntry = manifest.schedule.find(
      (entry) => entry.product === "data-wrangler" && entry.engine === "polars" && entry.format === "csv"
    );
    const parquetEntry = manifest.schedule.find(
      (entry) => entry.product === "data-wrangler" && entry.engine === "polars" && entry.format === "parquet"
    );
    assert.equal(manifestDeclaresDataWranglerPolarsUnavailable(manifest, csvEntry), expectedCsv);
    assert.equal(manifestDeclaresDataWranglerPolarsUnavailable(manifest, parquetEntry), expectedParquet);
  }
});

function planStudy(directory, dataWranglerPolarsAvailability = "available") {
  const specificationPath = resolve(directory, "spec.json");
  const manifestPath = resolve(directory, "manifest.json");
  const fragmentsDirectory = resolve(directory, "fragments");
  const intentsDirectory = resolve(directory, "intents");
  writeFileSync(specificationPath, JSON.stringify(studySpecification(dataWranglerPolarsAvailability)));
  const planned = runDataWranglerComparisonStudy(["plan", "--spec", specificationPath, "--out", manifestPath], {
    cwd: directory
  });
  return { manifestPath, fragmentsDirectory, intentsDirectory, manifest: planned.output };
}

function runDataWranglerComparisonStudyManifest(dataWranglerPolarsAvailability) {
  return buildDataWranglerStudyManifest(studySpecification(dataWranglerPolarsAvailability));
}

function preActionInvalidFragment(manifest, scheduleEntry, executionIndex) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt: scheduleEntry.attempt,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: {
      status: "pre-action-invalid",
      reasonClass: "setup",
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: null
    },
    milestones: createEmptyStudyMilestones(),
    cacheProof: null,
    engineEvidence: null,
    environmentGate: failedEnvironmentGate(manifest),
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    uiEvidence: null,
    processProofs: null,
    resourceObservation: null,
    cleanupProof: null,
    trialProvenance: null
  };
}

function currentLinuxLockOwner() {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const closingParenthesis = stat.lastIndexOf(")");
  const fields = stat
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  return {
    protocol: DATA_WRANGLER_STUDY_EXECUTION_LOCK_PROTOCOL,
    pid: process.pid,
    startTimeTicks: fields[19],
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    token: "55555555-5555-4555-8555-555555555555",
    acquiredAtUtc: "2026-08-02T11:00:00.000Z"
  };
}

function writeExecutionLock(manifestPath, record) {
  writeFileSync(dataWranglerStudyExecutionLockPath(manifestPath), JSON.stringify(record), { mode: 0o600 });
}

function studyComparisonDriverReceipt() {
  const modules = [
    { path: "shared/strictJson.cjs", sha256: digest("d") },
    { path: "test/extensionHost/dataWranglerComparisonNotebookTrial.js", sha256: digest("e") }
  ];
  return {
    extensionId: "openwrangler-study.notebook-comparison-driver",
    version: "1.0.0",
    vsix: {
      sha256: digest("f"),
      filesystemIdentity: {
        device: "2049",
        inode: "2101",
        sizeBytes: 4096,
        mtimeNs: "1754100000000000000"
      }
    },
    runtimeDependencies: {
      playwrightCore: {
        version: "1.61.1",
        fileCount: 106,
        totalBytes: 12_701_224,
        treeSha256: digest("a"),
        lockIntegrity: "sha512-dGVzdC1wbGF5d3JpZ2h0LWNvcmU="
      }
    },
    journeyGraph: {
      entry: "test/extensionHost/dataWranglerComparisonNotebookTrial.js",
      moduleCount: modules.length,
      totalBytes: 32_768,
      graphSha256: createHash("sha256").update(JSON.stringify(modules), "utf8").digest("hex"),
      modules
    }
  };
}

function studySpecification(dataWranglerPolarsAvailability = "available") {
  const editor = {
    id: "Microsoft.VisualStudioCode",
    version: "1.130.0",
    sha256: digest("3"),
    uiLocale: "en"
  };
  const fixtures = [
    studyFixture("csv-100k-50", "csv", 100_000, 50, digest("6"), "6001"),
    studyFixture("parquet-1m-20", "parquet", 1_000_000, 20, digest("7"), "7001")
  ];
  const capabilityContexts = fixtures.map((fixture, index) =>
    publicUiContext(
      index === 0 ? "22222222-2222-4222-8222-222222222222" : "44444444-4444-4444-8444-444444444444",
      editor,
      fixture
    )
  );
  const controlContext = publicUiContext("33333333-3333-4333-8333-333333333333", editor, fixtures[0]);
  const availabilityFor = (fixture) =>
    typeof dataWranglerPolarsAvailability === "string"
      ? dataWranglerPolarsAvailability
      : dataWranglerPolarsAvailability[fixture.id];
  const capabilityReceipts = fixtures.map((fixture, index) => {
    const availability = availabilityFor(fixture);
    if (!["available", "unavailable"].includes(availability)) {
      throw new TypeError(`Missing test capability for ${fixture.id}.`);
    }
    return createDataWranglerPolarsCapabilityReceipt(
      publicUiEvidence(
        DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
        capabilityContexts[index],
        availability === "available" ? "available" : "unsupported"
      ),
      capabilityContexts[index]
    );
  });
  const controlReceipt = createNeitherProductControlReceipt(
    publicUiEvidence(NEITHER_PRODUCT_CONTROL_RECEIPT_KIND, controlContext, "neither-product-control"),
    controlContext
  );
  return {
    studyId: "11111111-1111-4111-8111-111111111111",
    createdAtUtc: "2026-08-02T10:00:00.000Z",
    method: { protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL, sha256: digest("1") },
    candidate: {
      extensionId: "Matt17BR.openwrangler",
      version: "1.2.1",
      sha256: digest("2"),
      filesystemIdentity: { device: "2049", inode: "2001", sizeBytes: 1024, mtimeNs: "1754100000000000000" }
    },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor,
    python: {
      implementation: "CPython",
      version: "3.12.10",
      executableSha256: digest("4"),
      environmentSha256: digest("5"),
      packages: [
        { name: "pandas", version: "2.2.3" },
        { name: "polars", version: "1.27.1" },
        { name: "pyarrow", version: "19.0.1" },
        { name: "jupyter_core", version: "5.7.2" },
        { name: "ipykernel", version: "6.29.5" }
      ],
      kernel: {
        implementation: "ipykernel",
        version: "6.29.5",
        kernelspecName: "python3",
        kernelspecSha256: digest("a")
      }
    },
    fixtures,
    provenance: {
      machine: {
        platform: "linux",
        architecture: "x64",
        osRelease: "Ubuntu 24.04.2 LTS",
        kernelRelease: "6.8.0-64-generic",
        machineIdSha256: digest("8"),
        totalMemoryBytes: 32 * 1024 * 1024 * 1024
      },
      cpu: {
        vendorId: "GenuineIntel",
        model: "Example 8-core CPU",
        logicalProcessorCount: 8,
        onlineCpuList: "0-7",
        affinity: [2, 3, 4, 5],
        governors: [2, 3, 4, 5].map((processor) => ({ processor, governor: "performance" }))
      },
      power: { source: "ac" },
      storage: {
        deviceModel: "Example NVMe SSD",
        deviceIdentitySha256: digest("b"),
        filesystemType: "ext4",
        mountOptionsSha256: digest("c"),
        fixtureVolumeIdentitySha256: digest("d"),
        rotational: false
      },
      display: { mode: "headless-ozone", widthPx: 1920, heightPx: 1080, deviceScaleFactor: 1, colorDepth: 24 },
      zoom: {
        level: 0,
        theme: "Default Dark Modern",
        viewportWidthPx: 1920,
        viewportHeightPx: 1080,
        rowPageSize: 50,
        notebookLayoutSha256: digest("9")
      },
      commonExtensions: DATA_WRANGLER_STUDY_COMMON_EXTENSIONS.map((extension) => ({ ...extension })),
      comparisonDriver: studyComparisonDriverReceipt(),
      templates: DATA_WRANGLER_STUDY_PRODUCTS.map((product, index) => ({
        product,
        configuredOnlyReceiptSha256: digest(String(index + 1)),
        warmedReceiptSha256: digest(String(index + 3)),
        publicConfigurationCompleted: true,
        publicWarmupCompleted: true,
        targetStateAbsent: true
      })),
      capabilities: fixtures.map((fixture, index) => {
        const receipt = capabilityReceipts[index];
        return {
          product: "data-wrangler",
          engine: "polars",
          availability: availabilityFor(fixture),
          method: "public-capability",
          timed: false,
          fixtureId: fixture.id,
          context: capabilityContexts[index],
          receiptSha256: digestStudyValue(receipt),
          receipt
        };
      }),
      controlProfile: {
        method: "neither-product",
        fixtureId: fixtures[0].id,
        context: controlContext,
        receiptSha256: digestStudyValue(controlReceipt),
        receipt: controlReceipt
      },
      ownershipTracker: {
        protocol: "openwrangler-linux-study-supervisor-v1",
        supervisorSource: {
          sha256: "a".repeat(64),
          filesystemIdentity: {
            device: "8",
            inode: "42",
            sizeBytes: 125_000,
            mtimeNs: "1000000000"
          }
        },
        pythonExecutable: {
          implementation: "CPython",
          version: "3.12.10",
          sha256: digest("4"),
          filesystemIdentity: {
            device: "8",
            inode: "43",
            sizeBytes: 6_000_000,
            mtimeNs: "1000000000"
          }
        },
        invocationPolicySha256: "c".repeat(64)
      }
    }
  };
}

function publicUiContext(captureId, editor, fixture) {
  return createPublicUiReceiptContext({
    captureId,
    editor,
    source: {
      variableName: "study_frame",
      engine: "polars",
      semanticClass: "dataframe",
      rowCount: fixture.rows,
      columnCount: fixture.columns,
      schemaSha256: digestStudyValue(fixture.schema),
      sentinels: fixture.sentinels.map((sentinel) => ({
        rowIndex: sentinel.rowIndex,
        columnName: sentinel.column,
        value: sentinel.value
      }))
    }
  });
}

function publicUiEvidence(kind, context, conclusion) {
  const available = conclusion === "available";
  const startedAtMonotonicMs = 8_456_000;
  const endedAtMonotonicMs = available
    ? startedAtMonotonicMs + 475
    : startedAtMonotonicMs + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS;
  const times = available
    ? [startedAtMonotonicMs, startedAtMonotonicMs + 250, endedAtMonotonicMs]
    : [...Array(PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS / PUBLIC_UI_OBSERVATION_MAX_GAP_MS + 1).keys()].map(
        (index) => startedAtMonotonicMs + index * PUBLIC_UI_OBSERVATION_MAX_GAP_MS
      );
  const trace = times.map((atMonotonicMs, index) => ({
    atMonotonicMs,
    output: publicUiOutput(),
    actions: publicUiActions(available && index >= times.length - 2)
  }));
  return {
    captureId: context.captureId,
    editor: structuredClone(context.editor),
    extensions: structuredClone(createExpectedPublicUiExtensionInventory(kind)),
    source: structuredClone(context.source),
    observation: {
      clock: "linux-monotonic",
      startedAtMonotonicMs,
      endedAtMonotonicMs,
      absenceDeadlineAtMonotonicMs: startedAtMonotonicMs + PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
      maxGapMs: PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
      sampleCount: trace.length
    },
    trace,
    output: structuredClone(trace.at(-1).output),
    actions: structuredClone(trace.at(-1).actions),
    conclusion
  };
}

function publicUiOutput() {
  return { ready: true, busy: false, obstructed: false, owner: "host-jupyter" };
}

function publicUiActions(dataWranglerAvailable) {
  return [
    {
      product: "open-wrangler",
      accessibleName: PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
      matchCount: 0,
      pointerUsable: false
    },
    {
      product: "data-wrangler",
      accessibleName: PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
      matchCount: dataWranglerAvailable ? 1 : 0,
      pointerUsable: dataWranglerAvailable
    }
  ];
}

function studyFixture(id, format, rows, columns, sha256, inode) {
  return {
    id,
    format,
    rows,
    columns,
    sha256,
    filesystemIdentity: { device: "2049", inode, sizeBytes: rows * columns, mtimeNs: "1754100000000000000" },
    schema: [...Array(columns).keys()].map((index) => ({
      name: `c${String(index).padStart(2, "0")}`,
      dtype: "int64"
    })),
    sentinels: [
      { rowIndex: 0, column: "c00", value: 0 },
      { rowIndex: 1, column: "c01", value: 2 },
      {
        rowIndex: rows - 1,
        column: `c${String(columns - 1).padStart(2, "0")}`,
        value: rows - 1 + columns - 1
      }
    ]
  };
}

function failedEnvironmentGate(manifest) {
  return {
    protocol: "openwrangler-linux-data-wrangler-study-gate-v1",
    selectionPolicy: "accept the first complete passing window and retain every attempted window",
    thresholds: {
      windowMs: 10_000,
      intervalMs: 1_000,
      maximumMeanNonIdleCpuPercent: 10,
      maximumOneSecondNonIdleCpuPercent: 25,
      maximumCpuSomeAvg10Percent: 1,
      maximumMemoryFullAvg10Percent: 0,
      maximumSwapPageDelta: 0,
      maximumThermalThrottleDelta: 0,
      requireExactAcPowerState: true,
      requireExactGovernorSet: true,
      requireExactAffinity: true,
      maximumSampleLatenessMs: 250
    },
    provenance: {
      protocol: "openwrangler-linux-data-wrangler-study-provenance-v1",
      platform: "linux",
      architecture: "x64",
      kernelRelease: manifest.provenance.machine.kernelRelease,
      cpu: {
        vendorId: manifest.provenance.cpu.vendorId,
        modelName: manifest.provenance.cpu.model,
        logicalCpuCount: manifest.provenance.cpu.logicalProcessorCount,
        onlineCpuList: manifest.provenance.cpu.onlineCpuList,
        pinnedCpuIds: [...manifest.provenance.cpu.affinity]
      },
      affinity: { cpuList: "2-5" },
      power: {
        externalSupplies: [{ name: "AC", type: "Mains", online: true }],
        governors: manifest.provenance.cpu.governors.map((governor) => ({
          cpuId: governor.processor,
          governor: governor.governor
        })),
        thermalThrottleCounters: [{ id: "core:2", cpuId: 2, kind: "core" }]
      },
      display: {
        mode: manifest.provenance.display.mode,
        width: manifest.provenance.display.widthPx,
        height: manifest.provenance.display.heightPx,
        scaleFactor: manifest.provenance.display.deviceScaleFactor,
        zoomLevel: manifest.provenance.zoom.level,
        theme: manifest.provenance.zoom.theme,
        hostEnvironment: { displaySet: false, waylandDisplaySet: false, xdgSessionTypeSet: false }
      }
    },
    maximumWaitMs: 300_000,
    waitMs: 300_000,
    acceptedAttempt: null,
    passed: false,
    terminalFailure: "deadline-no-complete-window",
    attempts: [...Array(30).keys()].map((attemptIndex) => ({
      attempt: attemptIndex + 1,
      startedAtOffsetMs: attemptIndex * 10_000,
      durationMs: 10_000,
      passed: false,
      failureCodes: ["cpu-mean", "cpu-window", "cpu-pressure"],
      summary: {
        cpuIds: [...manifest.provenance.cpu.affinity],
        meanNonIdleCpuPercent: 26,
        maximumOneSecondNonIdleCpuPercent: 26,
        maximumCpuSomeAvg10Percent: 1.1,
        maximumMemoryFullAvg10Percent: 0,
        swapPageDelta: { pagesIn: 0, pagesOut: 0 },
        thermalThrottleDeltas: [{ id: "core:2", delta: 0 }],
        acPowerMatched: true,
        governorsMatched: true,
        affinityMatched: true
      },
      intervals: [...Array(10).keys()].map((intervalIndex) => ({
        index: intervalIndex,
        elapsedMs: (intervalIndex + 1) * 1_000,
        durationMs: 1_000,
        nonIdleCpuPercent: 26,
        cpuSomeAvg10Percent: 1.1,
        memoryFullAvg10Percent: 0,
        acPowerMatched: true,
        governorsMatched: true,
        affinityMatched: true,
        available: true
      }))
    }))
  };
}

function withDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-command-"));
  let result;
  try {
    result = callback(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  if (result && typeof result.then === "function") {
    return Promise.resolve(result).finally(() => rmSync(directory, { recursive: true, force: true }));
  }
  rmSync(directory, { recursive: true, force: true });
  return result;
}
