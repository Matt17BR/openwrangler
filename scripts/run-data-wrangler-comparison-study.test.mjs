import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import {
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_PRODUCTS,
  buildDataWranglerStudyManifest,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue,
  inspectDataWranglerStudyTrialIntents,
  loadDataWranglerStudyFragments,
  readDataWranglerStudyManifestPublication,
  readDataWranglerStudySpecificationPublication,
  summarizeDataWranglerStudyTrialResource,
  validateDataWranglerStudyFragment,
  writeDataWranglerStudySpecificationExclusive
} from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
  loadDataWranglerComparisonPreparationReceipt,
  writeDataWranglerComparisonPreparationReceipt
} from "./data-wrangler-comparison-preparation.mjs";
import {
  captureDataWranglerComparisonPreregistration,
  createDataWranglerComparisonPreregistrationReceipt
} from "./data-wrangler-comparison-preregistration.mjs";
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
  dataWranglerStudyExecutionLockPath,
  manifestDeclaresDataWranglerPolarsUndetermined,
  parseDataWranglerComparisonStudyArguments,
  runNextDataWranglerComparisonStudyTrial,
  runDataWranglerComparisonStudy as runDataWranglerComparisonStudyRaw
} from "./run-data-wrangler-comparison-study.mjs";
import { runUnrecordedPreparedDataWranglerComparisonDiagnostic } from "./run-data-wrangler-comparison-prepared.mjs";

const digest = (value) => value.repeat(64);

// Keep valid started-action evidence on the same shared fixture boundary used
// by the trial-fragment tests.
function loadActionStartedFragmentFixture() {
  const source = readFileSync(resolve("scripts/data-wrangler-comparison-study.test.mjs"), "utf8");
  const start = source.indexOf("function studyFixture(");
  assert.notEqual(start, -1);
  const context = {
    assert,
    createHash,
    createStudyFragmentIdentity,
    digestStudyValue,
    buildDataWranglerStudyManifest,
    DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
    DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
    DATA_WRANGLER_STUDY_PRODUCTS,
    DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
    NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
    PUBLIC_UI_CAPABILITY_ABSENCE_WINDOW_MS,
    PUBLIC_UI_DATA_WRANGLER_ACTION_NAME,
    PUBLIC_UI_OBSERVATION_MAX_GAP_MS,
    PUBLIC_UI_OPEN_WRANGLER_ACTION_NAME,
    createDataWranglerPolarsCapabilityReceipt,
    createExpectedPublicUiExtensionInventory,
    createNeitherProductControlReceipt,
    createPublicUiReceiptContext,
    DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY
  };
  const fixtureSource = `const { ${Object.keys(context).join(", ")} } = globalThis.__runNextFixtureDeps;\nconst digest = (value) => value.repeat(64);\n${source.slice(start)}\n;globalThis.__runNextFixtures = { successFragment };`;
  globalThis.__runNextFixtureDeps = context;
  try {
    vm.runInThisContext(fixtureSource, { filename: "run-next-study-fragment-fixtures.mjs" });
    return globalThis.__runNextFixtures;
  } finally {
    delete globalThis.__runNextFixtures;
    delete globalThis.__runNextFixtureDeps;
  }
}

const actionStartedFragmentFixture = loadActionStartedFragmentFixture();

function planArguments(specificationPath, manifestPath) {
  const root = resolve(specificationPath, "..");
  return [
    "plan",
    "--spec",
    specificationPath,
    "--out",
    manifestPath,
    "--preregistration",
    resolve(root, "preregistration.json"),
    "--preparation",
    resolve(root, "preparation.json"),
    "--cache-controller",
    resolve(root, "source-cache-control.py"),
    "--python",
    resolve(root, "python")
  ];
}

function testJourneyGraph() {
  const modules = [{ path: "test/extensionHost/dataWranglerComparisonNotebookTrial.js", sha256: digest("b") }];
  return {
    entry: modules[0].path,
    moduleCount: 1,
    totalBytes: 100,
    graphSha256: createHash("sha256").update(JSON.stringify(modules), "utf8").digest("hex"),
    modules
  };
}

function testExecutionGraph() {
  const entries = [
    "scripts/run-data-wrangler-comparison-preparation.mjs",
    "scripts/run-data-wrangler-comparison-study-entry.mjs"
  ];
  const modules = entries.map((path, index) => ({ path, sha256: String(index + 1).repeat(64) }));
  const edges = entries.map((from) => ({ from, kind: "import", specifier: "node:fs", target: "external:node:fs" }));
  const value = {
    protocol: "openwrangler-data-wrangler-comparison-execution-graph-v1",
    scope: ["scripts/", "src/shared/"],
    parser: {
      implementation: "typescript",
      version: ts.version,
      scriptKind: "JavaScript",
      scriptTarget: "Latest"
    },
    entries,
    moduleCount: 2,
    edgeCount: edges.length,
    totalBytes: 200,
    externalSpecifiers: ["node:fs"],
    modules,
    edges
  };
  return { ...value, graphSha256: digestStudyValue(value) };
}

const TEST_PREREGISTRATION = captureDataWranglerComparisonPreregistration(
  {
    studyId: "11111111-1111-4111-8111-111111111111",
    createdAtUtc: "2026-08-02T10:00:00.000Z",
    journeyPath: "/compiled/dataWranglerComparisonNotebookTrial.js"
  },
  {
    captureFile: () => ({ sha256: digest("a") }),
    captureMethodology: () => ({ protocol: DATA_WRANGLER_STUDY_METHOD_PROTOCOL, sha256: digest("1") }),
    proveJourneyGraph: testJourneyGraph,
    proveExecutionGraph: testExecutionGraph
  }
);
const TEST_PREREGISTRATION_RECEIPT = createDataWranglerComparisonPreregistrationReceipt(TEST_PREREGISTRATION);

function runDataWranglerComparisonStudy(argv, options = {}) {
  if (argv[0] !== "plan") return runDataWranglerComparisonStudyRaw(argv, options);
  const valueFor = (flag) => argv[argv.indexOf(flag) + 1];
  const specificationPath = valueFor("--spec");
  let specification = studySpecification();
  try {
    const metadata = lstatSync(specificationPath);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      specification = JSON.parse(readFileSync(specificationPath, "utf8"));
    }
  } catch {
    // The production reader owns missing, linked, and swapped-input diagnostics.
  }
  const authorization = {
    preregistrationPath: valueFor("--preregistration"),
    preregistrationSha256: digestStudyValue(TEST_PREREGISTRATION),
    specificationPath,
    specificationSha256: digestStudyValue(specification),
    specification,
    manifestPath: valueFor("--out"),
    manifestSha256: digestStudyValue(buildDataWranglerStudyManifest(specification))
  };
  return runDataWranglerComparisonStudyRaw(argv, {
    readPreregistration: () => TEST_PREREGISTRATION,
    assertCurrentPreregistration: () => TEST_PREREGISTRATION,
    loadPreparation: () => authorization,
    ...options
  });
}

function captureSpecificationCacheToolchain() {
  return structuredClone(studySpecification().provenance.cacheToolchain);
}

function captureSpecificationMethodology() {
  return structuredClone(studySpecification().method);
}

test("study command arguments are explicit and reject missing or repeated paths", () => {
  assert.deepEqual(
    parseDataWranglerComparisonStudyArguments(
      [
        "plan",
        "--spec",
        "spec.json",
        "--out",
        "manifest.json",
        "--preregistration",
        "preregistration.json",
        "--preparation",
        "preparation.json",
        "--cache-controller",
        "source-cache.py",
        "--python",
        "python"
      ],
      "/work"
    ),
    {
      command: "plan",
      spec: "/work/spec.json",
      out: "/work/manifest.json",
      preregistration: "/work/preregistration.json",
      preparation: "/work/preparation.json",
      cacheController: "/work/source-cache.py",
      python: "/work/python"
    }
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
          runDataWranglerComparisonStudy(planArguments(linkedSpecification, resolve(directory, "manifest.json")), {
            cwd: directory,
            captureCacheToolchain: captureSpecificationCacheToolchain,
            captureMethodology: captureSpecificationMethodology
          }),
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
          runDataWranglerComparisonStudy(planArguments(specification, resolve(directory, "manifest.json")), {
            cwd: directory,
            captureCacheToolchain: captureSpecificationCacheToolchain,
            captureMethodology: captureSpecificationMethodology,
            inputReadOptions: {
              faultInjector: (point, label) => {
                if (point === "file-opened" && label === "Study specification") {
                  renameSync(specification, displaced);
                  writeFileSync(specification, JSON.stringify(studySpecification()));
                }
              }
            }
          }),
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
        runDataWranglerComparisonStudy(planArguments(specification, manifest), {
          cwd: directory,
          captureCacheToolchain: captureSpecificationCacheToolchain,
          captureMethodology: captureSpecificationMethodology
        });
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

test("fragment loading rejects an oversized cumulative ledger before parsing any fragment", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const fragmentsDirectory = resolve(directory, "fragments");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));
    const manifest = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain: captureSpecificationCacheToolchain,
      captureMethodology: captureSpecificationMethodology
    }).output;
    mkdirSync(fragmentsDirectory, { mode: 0o700 });
    for (let attempt = 0; attempt < 9; attempt += 1) {
      const path = resolve(
        fragmentsDirectory,
        `${manifest.schedule[0].id}.attempt-${String(attempt).padStart(2, "0")}.json`
      );
      writeFileSync(path, "{}\n", { mode: 0o600 });
      truncateSync(path, 32 * 1024 * 1024);
    }
    assert.throws(() => loadDataWranglerStudyFragments(fragmentsDirectory, manifest), /cumulative byte bound/u);
  });
});

test("plan, record, and status preserve one immutable manifest and append-only fragment", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const fragmentInputPath = resolve(directory, "fragment-input.json");
    const fragments = resolve(directory, "fragments");
    writeFileSync(specificationPath, JSON.stringify(studySpecification()));

    const planned = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain: captureSpecificationCacheToolchain,
      captureMethodology: captureSpecificationMethodology
    });
    assert.equal(planned.output.schedule.length, 96);
    assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).studyId, planned.output.studyId);
    const repeatedPlan = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain: captureSpecificationCacheToolchain,
      captureMethodology: captureSpecificationMethodology
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
      sourceCopy: null,
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

test("plan verifies the authorized cache toolchain and rejects caller-supplied drift", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const controllerPath = resolve(directory, "source-cache-control.py");
    const pythonPath = resolve(directory, "python");
    const observed = captureSpecificationCacheToolchain();
    const specification = studySpecification();
    writeFileSync(specificationPath, JSON.stringify(specification));
    let captured;
    const planned = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain(options) {
        captured = options;
        return observed;
      },
      captureMethodology: captureSpecificationMethodology
    });
    assert.deepEqual(captured, {
      controllerPath,
      pythonExecutablePath: pythonPath
    });
    assert.deepEqual(planned.output.provenance.cacheToolchain, observed);

    const mismatchedSpecificationPath = resolve(directory, "mismatched-spec.json");
    const mismatchedManifestPath = resolve(directory, "mismatched-manifest.json");
    const mismatched = studySpecification();
    mismatched.provenance.cacheToolchain.controller.sha256 = "9".repeat(64);
    writeFileSync(mismatchedSpecificationPath, JSON.stringify(mismatched));
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(planArguments(mismatchedSpecificationPath, mismatchedManifestPath), {
          cwd: directory,
          captureCacheToolchain: () => observed,
          captureMethodology: captureSpecificationMethodology
        }),
      /does not match the plan-time observed files/u
    );
    assert.equal(existsSync(mismatchedManifestPath), false);
  });
});

test("plan rejects a claimed preregistration digest before cache or publication work", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "specification.json");
    const manifestPath = resolve(directory, "manifest.json");
    const specification = studySpecification();
    writeFileSync(specificationPath, JSON.stringify(specification));
    let cacheCaptureCalls = 0;
    assert.throws(
      () =>
        runDataWranglerComparisonStudyRaw(planArguments(specificationPath, manifestPath), {
          cwd: directory,
          readPreregistration: () => TEST_PREREGISTRATION,
          assertCurrentPreregistration: () => TEST_PREREGISTRATION,
          loadPreparation: () => ({
            preregistrationPath: resolve(directory, "preregistration.json"),
            preregistrationSha256: "f".repeat(64),
            specificationPath,
            specificationSha256: digestStudyValue(specification),
            specification,
            manifestPath,
            manifestSha256: digestStudyValue(buildDataWranglerStudyManifest(specification))
          }),
          captureCacheToolchain() {
            cacheCaptureCalls += 1;
            return captureSpecificationCacheToolchain();
          },
          captureMethodology: captureSpecificationMethodology
        }),
      /not authorized by the exact preregistration/u
    );
    assert.equal(cacheCaptureCalls, 0);
    assert.equal(existsSync(manifestPath), false);
  });
});

test("durable specification and preparation publications feed the production diagnostic readers", async () => {
  await withDirectory(async (directory) => {
    const specification = studySpecification();
    const specificationPath = resolve(directory, "specification.json");
    const manifestPath = resolve(directory, "manifest.json");
    const preparationPath = resolve(directory, "preparation.json");
    writeDataWranglerStudySpecificationExclusive(specificationPath, specification);
    assert.deepEqual(readDataWranglerStudySpecificationPublication(specificationPath), specification);
    const manifest = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain: captureSpecificationCacheToolchain,
      captureMethodology: captureSpecificationMethodology
    }).output;
    const path = (name) => resolve(directory, name);
    const preparation = {
      protocol: DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL,
      preregistrationPath: path("preregistration.json"),
      preregistrationSha256: digestStudyValue(TEST_PREREGISTRATION),
      specificationPath,
      specificationSha256: digestStudyValue(specification),
      specification,
      manifestPath,
      manifestSha256: digestStudyValue(manifest),
      studyRoot: directory,
      candidate: { path: path("candidate.vsix") },
      editor: {
        installationRoot: path("editor"),
        executablePath: path("editor/code"),
        cliPath: path("editor/code-cli")
      },
      python: { path: path("python") },
      cacheController: { path: path("source-cache-control.py") },
      driver: { directory: path("driver"), vsixPath: path("driver/driver.vsix") },
      fixtures: [{ path: path("fixture.csv") }, { path: path("fixture.parquet") }],
      selectedKernel: {
        path: path("jupyter/data/kernels/study/kernel.json"),
        jupyterEnvironment: {
          dataDir: path("jupyter/data"),
          runtimeDir: path("jupyter/runtime"),
          configDir: path("jupyter/config"),
          path: path("jupyter/path")
        }
      },
      templates: [{}, {}, {}, {}],
      publicUiCaptures: [{}, {}, {}],
      createdAtUtc: "2026-08-02T10:00:00.000Z"
    };
    writeDataWranglerComparisonPreparationReceipt(preparationPath, preparation);
    assert.deepEqual(loadDataWranglerComparisonPreparationReceipt(preparationPath), preparation);

    let observedPrivatePublications = false;
    const summary = await runUnrecordedPreparedDataWranglerComparisonDiagnostic(
      { manifestPath, preparationPath },
      {},
      {
        revalidatePreparation: async (value) => value,
        async runEntry(options) {
          const privateManifest = readDataWranglerStudyManifestPublication(options.manifestPath);
          const privatePreparation = loadDataWranglerComparisonPreparationReceipt(options.preparationPath);
          assert.deepEqual(privateManifest, manifest);
          assert.equal(privatePreparation.manifestPath, options.manifestPath);
          assert.equal(privatePreparation.manifestSha256, digestStudyValue(privateManifest));
          observedPrivatePublications = true;
          const output = actionStartedFragmentFixture.successFragment(
            privateManifest,
            privateManifest.schedule[0],
            0,
            10,
            0
          );
          const malformed = structuredClone(output);
          delete malformed.resourceObservation.samples[0].processes;
          assert.throws(
            () => summarizeDataWranglerStudyTrialResource(malformed),
            /PSS sample.*missing or unknown fields/u
          );
          return {
            status: "recorded",
            receipt: null,
            cleanup: { status: "retired", treeEmpty: true },
            output
          };
        }
      }
    );
    assert.equal(observedPrivatePublications, true);
    assert.equal(summary.cleanupVerified, true);
    assert.equal(summary.recorded, false);
  });
});

test("plan rejects a specification that is not bound to the checked-in reviewed methodology", () => {
  withDirectory((directory) => {
    const specificationPath = resolve(directory, "spec.json");
    const manifestPath = resolve(directory, "manifest.json");
    const specification = studySpecification();
    specification.method.sha256 = "9".repeat(64);
    writeFileSync(specificationPath, JSON.stringify(specification));
    assert.throws(
      () =>
        runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
          cwd: directory,
          captureCacheToolchain: captureSpecificationCacheToolchain,
          captureMethodology: captureSpecificationMethodology
        }),
      /does not match the checked-in reviewed document/u
    );
    assert.equal(existsSync(manifestPath), false);
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
        runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
          cwd: directory,
          captureCacheToolchain: captureSpecificationCacheToolchain,
          captureMethodology: captureSpecificationMethodology,
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
    const recovered = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
      cwd: directory,
      captureCacheToolchain: captureSpecificationCacheToolchain,
      captureMethodology: captureSpecificationMethodology
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

test("run-next validates the prepared schedule entry before executing or shortcutting it", async () => {
  await withDirectory(async (directory) => {
    const paths = planStudy(directory);
    let executed = false;
    await assert.rejects(
      runNextDataWranglerComparisonStudyTrial(paths, {
        expectedEntryId: "not-the-prepared-entry",
        executeTrial: async () => {
          executed = true;
          throw new Error("schedule mismatch executed");
        }
      }),
      /expected not-the-prepared-entry, but the durable ledger selected/u
    );
    assert.equal(executed, false);
    assert.equal(existsSync(paths.intentsDirectory), false);
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

  await t.test("a linked authorization is recovered into scheduler state after its publisher throws", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      let recovery;
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async ({
            manifest,
            scheduleEntry,
            executionIndex,
            authorizeAction,
            reinspectActionAuthorization
          }) => {
            assert.throws(authorizeAction, /injected action-authorization link crash/u);
            recovery = reinspectActionAuthorization();
            assert.equal(recovery.status, "authorized");
            assert.equal(recovery.authorization.publication.status, "recovered");
            return preActionInvalidFragment(manifest, scheduleEntry, executionIndex);
          },
          publicationOptions: {
            actionAuthorization: {
              tokenFactory: () => "2".repeat(32),
              faultInjector(point) {
                if (point === "target-linked") {
                  throw new Error("injected action-authorization link crash");
                }
              }
            }
          }
        }),
        /authorized a product action without retaining action-started evidence/u
      );
      assert.equal(recovery.authorization.intent.scheduleEntryId, paths.manifest.schedule[0].id);
      const inspection = inspectDataWranglerStudyTrialIntents({
        directory: paths.intentsDirectory,
        manifest: paths.manifest,
        fragments: []
      });
      assert.equal(inspection.unresolved.length, 1);
      assert.equal(inspection.unresolved[0].runId, recovery.authorization.intent.runId);
    });
  });

  await t.test("a recovered linked authorization publishes one exact started-action fragment", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      let authorizationCalls = 0;
      const recorded = await runNextDataWranglerComparisonStudyTrial(paths, {
        executeTrial: async ({
          manifest,
          scheduleEntry,
          executionIndex,
          authorizeAction,
          reinspectActionAuthorization
        }) => {
          authorizationCalls += 1;
          assert.throws(authorizeAction, /injected action-authorization link crash/u);
          const recovery = reinspectActionAuthorization();
          assert.equal(recovery.status, "authorized");
          assert.equal(recovery.authorization.publication.status, "recovered");
          return actionStartedFragmentFixture.successFragment(
            manifest,
            scheduleEntry,
            scheduleEntry.attempt,
            10,
            executionIndex
          );
        },
        publicationOptions: {
          actionAuthorization: {
            tokenFactory: () => "3".repeat(32),
            faultInjector(point) {
              if (point === "target-linked") {
                throw new Error("injected action-authorization link crash");
              }
            }
          }
        }
      });

      assert.equal(authorizationCalls, 1);
      assert.equal(recorded.status, "recorded");
      assert.equal(recorded.output.outcome.actionStarted, true);
      const fragments = loadDataWranglerStudyFragments(paths.fragmentsDirectory, paths.manifest);
      assert.equal(fragments.length, 1);
      assert.deepEqual(fragments[0], recorded.output);
      const inspection = inspectDataWranglerStudyTrialIntents({
        directory: paths.intentsDirectory,
        manifest: paths.manifest,
        fragments
      });
      assert.equal(inspection.authorizedCount, 1);
      assert.equal(inspection.settledCount, 1);
      assert.equal(inspection.unresolved.length, 0);
    });
  });

  await t.test("an action-started claim never authorizes after the executor returns", async () => {
    await withDirectory(async (directory) => {
      const paths = planStudy(directory);
      await assert.rejects(
        runNextDataWranglerComparisonStudyTrial(paths, {
          executeTrial: async () => ({ outcome: { actionStarted: true } })
        }),
        /reported a product action without durable authorization/u
      );
      const inspection = inspectDataWranglerStudyTrialIntents({
        directory: paths.intentsDirectory,
        manifest: paths.manifest,
        fragments: []
      });
      assert.equal(inspection.authorizedCount, 0);
      assert.equal(inspection.unresolved.length, 0);
    });
  });
});

test("a timed-out Data Wrangler Polars capability remains undetermined and cannot become a fragment", () => {
  const manifest = runDataWranglerComparisonStudyManifest("undetermined");
  const undeterminedEntry = manifest.schedule.find(
    (entry) => entry.product === "data-wrangler" && entry.engine === "polars"
  );
  assert.equal(manifestDeclaresDataWranglerPolarsUndetermined(manifest, undeterminedEntry), true);
  const claimedUnsupported = preActionInvalidFragment(
    manifest,
    { ...undeterminedEntry, attempt: 0, effectiveBlockId: `${undeterminedEntry.blockId}~a00` },
    undeterminedEntry.sequence
  );
  claimedUnsupported.outcome = {
    status: "unsupported",
    reasonClass: null,
    actionStarted: false,
    correctness: "not-reached",
    timeout: null,
    unsupported: { publicSurface: "unavailable", comparability: "non-comparable" }
  };
  assert.throws(
    () => validateDataWranglerStudyFragment(claimedUnsupported, manifest),
    /capability check is undetermined and cannot produce a study fragment/u
  );
});

test("Data Wrangler Polars availability is matched to the scheduled file format", () => {
  for (const [availability, expectedCsv, expectedParquet] of [
    [{ "csv-100k-50": "available", "parquet-1m-20": "undetermined" }, false, true],
    [{ "csv-100k-50": "undetermined", "parquet-1m-20": "available" }, true, false]
  ]) {
    const manifest = runDataWranglerComparisonStudyManifest(availability);
    const csvEntry = manifest.schedule.find(
      (entry) => entry.product === "data-wrangler" && entry.engine === "polars" && entry.format === "csv"
    );
    const parquetEntry = manifest.schedule.find(
      (entry) => entry.product === "data-wrangler" && entry.engine === "polars" && entry.format === "parquet"
    );
    assert.equal(manifestDeclaresDataWranglerPolarsUndetermined(manifest, csvEntry), expectedCsv);
    assert.equal(manifestDeclaresDataWranglerPolarsUndetermined(manifest, parquetEntry), expectedParquet);
  }
});

function planStudy(directory, dataWranglerPolarsAvailability = "available") {
  const specificationPath = resolve(directory, "spec.json");
  const manifestPath = resolve(directory, "manifest.json");
  const fragmentsDirectory = resolve(directory, "fragments");
  const intentsDirectory = resolve(directory, "intents");
  writeFileSync(specificationPath, JSON.stringify(studySpecification(dataWranglerPolarsAvailability)));
  const planned = runDataWranglerComparisonStudy(planArguments(specificationPath, manifestPath), {
    cwd: directory,
    captureCacheToolchain: captureSpecificationCacheToolchain,
    captureMethodology: captureSpecificationMethodology
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
    sourceCopy: null,
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
  const playwrightFiles = [
    { path: "index.js", sha256: digest("8") },
    { path: "package.json", sha256: digest("9") }
  ];
  const packageFiles = {
    packageJsonSha256: digest("6"),
    extensionSourceSha256: digest("7")
  };
  const archiveEntries = [
    { path: "[Content_Types].xml", sha256: digest("0") },
    { path: "extension.vsixmanifest", sha256: digest("1") },
    { path: "extension/extension.js", sha256: packageFiles.extensionSourceSha256 },
    ...modules.map((module) => ({ path: `extension/journey/${module.path}`, sha256: module.sha256 })),
    ...playwrightFiles.map((file) => ({
      path: `extension/node_modules/playwright-core/${file.path}`,
      sha256: file.sha256
    })),
    { path: "extension/package.json", sha256: packageFiles.packageJsonSha256 }
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
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
      },
      archive: {
        entryCount: archiveEntries.length,
        totalUncompressedBytes: 12_735_000,
        inventorySha256: createHash("sha256").update(JSON.stringify(archiveEntries), "utf8").digest("hex"),
        entries: archiveEntries
      }
    },
    packageFiles,
    runtimeDependencies: {
      playwrightCore: {
        version: "1.61.1",
        fileCount: playwrightFiles.length,
        totalBytes: 12_701_224,
        treeSha256: createHash("sha256").update(JSON.stringify(playwrightFiles), "utf8").digest("hex"),
        lockIntegrity: "sha512-dGVzdC1wbGF5d3JpZ2h0LWNvcmU=",
        files: playwrightFiles
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

function studyWarmupReceipt(product, editor, fixture) {
  const runId =
    product === "open-wrangler" ? "55555555-5555-4555-8555-555555555555" : "66666666-6666-4666-8666-666666666666";
  const phase = `comparison-study-${product}-warmup`;
  const bridgeKinds = [
    "source-verified",
    "measurement-ready",
    "sampling-origin",
    "inline-baseline",
    "workbench-baseline",
    "profile-baseline",
    "sampling-stop",
    "cleanup-census"
  ];
  const exchanges = bridgeKinds.map((kind, sequence) => ({
    request: {
      protocol: "openwrangler-data-wrangler-study-bridge-request-v1",
      runId,
      phase,
      sequence,
      kind,
      monotonicNanoseconds: String(sequence * 2 + 1)
    },
    acknowledgement: {
      protocol: "openwrangler-data-wrangler-study-bridge-ack-v1",
      runId,
      phase,
      sequence,
      kind,
      monotonicNanoseconds: String(sequence * 2 + 2)
    }
  }));
  return {
    protocol: "openwrangler-data-wrangler-public-warmup-phase-v1",
    product,
    untimed: true,
    locale: editor.uiLocale,
    editorVersion: editor.version,
    study: {
      engine: "polars",
      format: "csv",
      kind: "warm",
      fixture: { id: fixture.id, sha256: fixture.sha256, rows: fixture.rows, columns: fixture.columns },
      kernel: { name: "python3" },
      sourceReceipt: { sha256: fixture.sha256 },
      pythonImplementation: "CPython",
      pythonVersion: "3.12.10"
    },
    milestones: {
      inlineActionMs: 0,
      inlineReadyMs: 1,
      workbenchActionMs: 2,
      workbenchReadyMs: 3,
      profileActionMs: 4,
      firstProfileReadyMs: 5,
      profilesCompleteMs: 6
    },
    profiles: { expectedColumnCount: fixture.columns, completedColumnCount: fixture.columns, canonicalOrder: true },
    controlBridge: {
      clock: "process-hrtime-bigint",
      authoritativeForStudy: true,
      requestProtocol: "openwrangler-data-wrangler-study-bridge-request-v1",
      acknowledgementProtocol: "openwrangler-data-wrangler-study-bridge-ack-v1",
      exchanges
    },
    cleanup: { closeStatus: "succeeded", afterVerification: "matched" }
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
    if (!["available", "undetermined"].includes(availability)) {
      throw new TypeError(`Missing test capability for ${fixture.id}.`);
    }
    return createDataWranglerPolarsCapabilityReceipt(
      publicUiEvidence(
        DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
        capabilityContexts[index],
        availability === "available" ? "available" : "capability-timeout"
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
    preregistration: structuredClone(TEST_PREREGISTRATION_RECEIPT),
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
      cacheToolchain: {
        protocol: "openwrangler-data-wrangler-comparison-cache-toolchain-v1",
        controller: {
          sha256: digest("0"),
          filesystemIdentity: {
            device: "8",
            inode: "44",
            sizeBytes: 15_000,
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
        }
      },
      fixtureToolchain: {
        protocol: "openwrangler-performance-fixture-toolchain-v1",
        contractVersion: 1,
        implementation: "polars",
        implementationVersion: "1.27.1",
        generatorSha256: digest("e"),
        contractSha256: digest("f")
      },
      templates: DATA_WRANGLER_STUDY_PRODUCTS.map((product, index) => {
        const warmupReceipt = studyWarmupReceipt(product, editor, fixtures[0]);
        return {
          product,
          configuredOnlyReceiptSha256: digest(String(index + 1)),
          warmedReceiptSha256: digest(String(index + 3)),
          warmupReceiptSha256: digestStudyValue(warmupReceipt),
          warmupReceipt,
          publicConfigurationCompleted: true,
          publicWarmupCompleted: true,
          targetStateAbsent: true
        };
      }),
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
