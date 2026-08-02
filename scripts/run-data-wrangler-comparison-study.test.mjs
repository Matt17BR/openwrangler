import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue
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
  parseDataWranglerComparisonStudyArguments,
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

function studySpecification() {
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
  const capabilityContext = publicUiContext("22222222-2222-4222-8222-222222222222", editor, fixtures[0]);
  const controlContext = publicUiContext("33333333-3333-4333-8333-333333333333", editor, fixtures[0]);
  const capabilityReceipt = createDataWranglerPolarsCapabilityReceipt(
    publicUiEvidence(DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND, capabilityContext, "available"),
    capabilityContext
  );
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
      templates: DATA_WRANGLER_STUDY_PRODUCTS.map((product, index) => ({
        product,
        configuredOnlyReceiptSha256: digest(String(index + 1)),
        warmedReceiptSha256: digest(String(index + 3)),
        publicConfigurationCompleted: true,
        publicWarmupCompleted: true,
        targetStateAbsent: true
      })),
      capabilities: [
        {
          product: "data-wrangler",
          engine: "polars",
          availability: "available",
          method: "public-capability",
          timed: false,
          fixtureId: fixtures[0].id,
          context: capabilityContext,
          receiptSha256: digestStudyValue(capabilityReceipt),
          receipt: capabilityReceipt
        }
      ],
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
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
