import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import {
  DATA_WRANGLER_STUDY_CELLS,
  DATA_WRANGLER_STUDY_COMMON_EXTENSIONS,
  DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS,
  DATA_WRANGLER_STUDY_DEADLINES_MS,
  DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS,
  DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL,
  DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL,
  DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_METRICS,
  DATA_WRANGLER_STUDY_PRODUCTS,
  DATA_WRANGLER_STUDY_RESULT_PROTOCOL,
  DATA_WRANGLER_STUDY_SCHEDULE_SHA256,
  assertNoIndeterminateDataWranglerStudyAction,
  authorizeDataWranglerStudyTrialAction,
  buildDataWranglerStudyManifest,
  buildDataWranglerStudyResult,
  calculatePairedStudyRegression,
  calculateStudyPssSegments,
  createOrLoadDataWranglerStudyFinalizationIntent,
  createDataWranglerStudySchedule,
  createEmptyStudyMilestones,
  createStudyFragmentIdentity,
  digestStudyValue,
  inspectDataWranglerStudyTrialIntents,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  prepareDataWranglerStudyTrialIntent,
  publishDataWranglerStudyFragment,
  summarizeStudyMetric,
  type7Quantile,
  validateDataWranglerComparisonCacheBinding,
  validateDataWranglerComparisonSourceCopyBinding,
  validateDataWranglerStudyFragment,
  validateDataWranglerStudyManifest,
  validateDataWranglerStudyResult,
  validateDataWranglerStudyResultEvidence,
  writeDataWranglerStudyJsonExclusive
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
  createPublicUiReceiptContext,
  digestPublicUiReceiptEvidence
} from "./data-wrangler-public-ui-receipts.mjs";
import { LinuxPssTreeSampler } from "./linux-pss-sampler.mjs";

const digest = (value) => value.repeat(64);
const STUDY_SUPERVISOR_PATH = resolve("scripts/linux-study-supervisor.py");
const STUDY_PYTHON_312 = process.env.OPEN_WRANGLER_STUDY_PYTHON;

test("the fixed study schedule has four interleaved warm cells, ten balanced pairs, and cold AB/BA", () => {
  assert.deepEqual(DATA_WRANGLER_STUDY_PRODUCTS, ["open-wrangler", "data-wrangler"]);
  assert.equal(DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS, 3_000);
  assert.equal(DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES, 1_228);
  assert.deepEqual(
    DATA_WRANGLER_STUDY_METRICS.map((metric) => metric.name),
    ["inlinePreviewMs", "workbenchOpenMs", "firstProfileMs", "completeProfileMs", "completeTrialPssDeltaBytes"]
  );
  assert.deepEqual(DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS, [
    "firstProfileFromWorkbenchClickMs",
    "completeProfileFromWorkbenchClickMs"
  ]);
  const first = createDataWranglerStudySchedule();
  const second = createDataWranglerStudySchedule();
  assert.deepEqual(first, second);
  assert.equal(digestStudyValue(first), DATA_WRANGLER_STUDY_SCHEDULE_SHA256);
  assert.equal(first.length, 96);
  assert.deepEqual(
    first.map((entry) => entry.sequence),
    [...Array(96).keys()]
  );

  const warm = first.filter((entry) => entry.kind === "warm");
  const cold = first.filter((entry) => entry.kind === "cold");
  assert.equal(warm.length, 80);
  assert.equal(cold.length, 16);
  for (const cell of DATA_WRANGLER_STUDY_CELLS) {
    const firstProducts = warm
      .filter((entry) => entry.cellId === cell.id && entry.orderInPair === 1)
      .map((entry) => entry.product);
    assert.equal(firstProducts.length, 10);
    assert.equal(firstProducts.filter((product) => product === "open-wrangler").length, 5);
    assert.equal(firstProducts.filter((product) => product === "data-wrangler").length, 5);
    const coldOrders = cold
      .filter((entry) => entry.cellId === cell.id)
      .reduce((orders, entry) => {
        const current = orders.get(entry.blockId) ?? [];
        current.push(entry.product);
        orders.set(entry.blockId, current);
        return orders;
      }, new Map());
    assert.deepEqual(
      [...coldOrders.values()],
      [
        ["open-wrangler", "data-wrangler"],
        ["data-wrangler", "open-wrangler"]
      ]
    );
  }
  for (let repetition = 1; repetition <= 10; repetition += 1) {
    const cells = warm
      .filter((entry) => entry.repetition === repetition && entry.orderInPair === 1)
      .map((entry) => entry.cellId);
    assert.deepEqual(new Set(cells), new Set(DATA_WRANGLER_STUDY_CELLS.map((cell) => cell.id)));
  }
});

test("trial intents allow safe pre-action recovery but stop after an authorized action is lost", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-intents-"));
  const directory = resolve(root, "intents");
  try {
    const manifest = studyManifest();
    const fragments = [];
    const preparedAtUtc = "2026-08-02T12:00:00.000Z";
    const runId = "11111111-1111-4111-8111-111111111111";
    const prepared = prepareDataWranglerStudyTrialIntent({
      directory,
      manifest,
      fragments,
      runId,
      preparedAtUtc
    });
    assert.equal(prepared.publication.status, "published");
    assert.equal(prepared.intent.scheduleEntryId, manifest.schedule[0].id);
    assert.deepEqual(readdirSync(directory), [`${runId}.prepared.intent`]);
    assert.deepEqual(inspectDataWranglerStudyTrialIntents({ directory, manifest, fragments }), {
      preparedCount: 1,
      authorizedCount: 0,
      settledCount: 0,
      abandonedPreparedCount: 1,
      unresolved: []
    });

    const repeatedPreparation = prepareDataWranglerStudyTrialIntent({
      directory,
      manifest,
      fragments,
      runId,
      preparedAtUtc
    });
    assert.equal(repeatedPreparation.publication.status, "complete");

    const authorization = authorizeDataWranglerStudyTrialAction({
      directory,
      manifest,
      fragments,
      preparedIntent: prepared.intent,
      authorizedAtUtc: "2026-08-02T12:00:01.000Z"
    });
    assert.equal(authorization.publication.status, "published");
    assert.throws(
      () => assertNoIndeterminateDataWranglerStudyAction({ directory, manifest, fragments }),
      /authorized action without a published result/u
    );
    assert.throws(
      () =>
        prepareDataWranglerStudyTrialIntent({
          directory,
          manifest,
          fragments,
          runId: "22222222-2222-4222-8222-222222222222",
          preparedAtUtc: "2026-08-02T12:00:02.000Z"
        }),
      /earlier authorized action is indeterminate/u
    );

    const completed = successFragment(manifest, manifest.schedule[0], 0, 10, 0);
    assert.deepEqual(assertNoIndeterminateDataWranglerStudyAction({ directory, manifest, fragments: [completed] }), {
      preparedCount: 1,
      authorizedCount: 1,
      settledCount: 1,
      abandonedPreparedCount: 0,
      unresolved: []
    });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("action authorization rejects a prepared intent that no longer matches the ledger", () => {
  const root = mkdtempSync(resolve(tmpdir(), "ow-study-intent-ledger-"));
  const directory = resolve(root, "intents");
  try {
    const manifest = studyManifest();
    const prepared = prepareDataWranglerStudyTrialIntent({
      directory,
      manifest,
      fragments: [],
      runId: "33333333-3333-4333-8333-333333333333",
      preparedAtUtc: "2026-08-02T12:00:00.000Z"
    }).intent;
    const changed = { ...prepared, effectiveBlockId: "wrong~a00" };
    assert.throws(
      () =>
        authorizeDataWranglerStudyTrialAction({
          directory,
          manifest,
          fragments: [],
          preparedIntent: changed,
          authorizedAtUtc: "2026-08-02T12:00:01.000Z"
        }),
      /no longer matches the next ledger entry/u
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the versioned manifest binds the approved method, candidate, editor, Python, fixtures, and seeded schedule", () => {
  const manifest = studyManifest();
  assert.equal(manifest.protocol, DATA_WRANGLER_STUDY_MANIFEST_PROTOCOL);
  assert.equal(validateDataWranglerStudyManifest(manifest), manifest);
  assert.throws(
    () =>
      validateDataWranglerStudyManifest({
        ...manifest,
        protocol: "openwrangler-data-wrangler-study-manifest-v1"
      }),
    /manifest protocol/u
  );
  assert.match(digestStudyValue(manifest), /^[0-9a-f]{64}$/u);
  assert.deepEqual(
    manifest.provenance.capabilities.map((capability) => capability.fixtureId),
    manifest.fixtures.map((fixture) => fixture.id)
  );
  assert.deepEqual(manifest.provenance.commonExtensions[0], {
    extensionId: "ms-python.debugpy",
    version: "2026.6.0"
  });
  assert.equal(manifest.provenance.comparisonDriver.vsix.sha256, digest("f"));
  assert.equal(manifest.provenance.comparisonDriver.journeyGraph.modules.length, 2);
  assert.equal(manifest.provenance.comparisonDriver.runtimeDependencies.playwrightCore.files.length, 2);
  assert.equal(manifest.provenance.comparisonDriver.vsix.archive.entryCount, 8);

  const changedSchedule = structuredClone(manifest);
  [changedSchedule.schedule[0], changedSchedule.schedule[2]] = [
    changedSchedule.schedule[2],
    changedSchedule.schedule[0]
  ];
  assert.throws(() => validateDataWranglerStudyManifest(changedSchedule), /fixed seeded design/u);

  const incompleteDriverGraph = structuredClone(manifest);
  incompleteDriverGraph.provenance.comparisonDriver.journeyGraph.modules[0].sha256 = digest("0");
  assert.throws(
    () => validateDataWranglerStudyManifest(incompleteDriverGraph),
    /graph SHA-256 does not match its complete module list/u
  );

  const changedDriverArchive = structuredClone(manifest);
  changedDriverArchive.provenance.comparisonDriver.vsix.archive.entries[2].sha256 = digest("0");
  changedDriverArchive.provenance.comparisonDriver.vsix.archive.inventorySha256 = createHash("sha256")
    .update(JSON.stringify(changedDriverArchive.provenance.comparisonDriver.vsix.archive.entries), "utf8")
    .digest("hex");
  assert.throws(
    () => validateDataWranglerStudyManifest(changedDriverArchive),
    /does not exactly match its package, journey, and Playwright receipts/u
  );

  const wrongPython = structuredClone(manifest);
  wrongPython.python.version = "3.14.0";
  assert.throws(() => validateDataWranglerStudyManifest(wrongPython), /Python version/u);

  const missingPythonPackage = structuredClone(manifest);
  missingPythonPackage.python.packages.pop();
  assert.throws(() => validateDataWranglerStudyManifest(missingPythonPackage), /package inventory/u);

  const wrongKernelVersion = structuredClone(manifest);
  wrongKernelVersion.python.kernel.version = "6.29.4";
  assert.throws(() => validateDataWranglerStudyManifest(wrongKernelVersion), /match the pinned ipykernel/u);

  const mismatchedSupervisorPythonPatch = structuredClone(manifest);
  mismatchedSupervisorPythonPatch.provenance.ownershipTracker.pythonExecutable.version = "3.12.9";
  assert.throws(
    () => validateDataWranglerStudyManifest(mismatchedSupervisorPythonPatch),
    /exact manifest-pinned Python executable/u
  );

  const mismatchedSupervisorPythonHash = structuredClone(manifest);
  mismatchedSupervisorPythonHash.provenance.ownershipTracker.pythonExecutable.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDataWranglerStudyManifest(mismatchedSupervisorPythonHash),
    /exact manifest-pinned Python executable/u
  );

  const mismatchedCachePythonPatch = structuredClone(manifest);
  mismatchedCachePythonPatch.provenance.cacheToolchain.pythonExecutable.version = "3.12.9";
  assert.throws(
    () => validateDataWranglerStudyManifest(mismatchedCachePythonPatch),
    /source-cache Python does not match/u
  );

  const mismatchedCachePythonHash = structuredClone(manifest);
  mismatchedCachePythonHash.provenance.cacheToolchain.pythonExecutable.sha256 = "b".repeat(64);
  assert.throws(
    () => validateDataWranglerStudyManifest(mismatchedCachePythonHash),
    /source-cache Python does not match/u
  );

  const changedAffinity = structuredClone(manifest);
  changedAffinity.provenance.cpu.affinity[0] = 9;
  assert.throws(() => validateDataWranglerStudyManifest(changedAffinity), /machine topology/u);

  const changedInventory = structuredClone(manifest);
  changedInventory.provenance.commonExtensions[0].version = "2026.6.1";
  assert.throws(() => validateDataWranglerStudyManifest(changedInventory), /preregistered lock/u);

  const staleTemplate = structuredClone(manifest);
  staleTemplate.provenance.templates[1].targetStateAbsent = false;
  assert.throws(() => validateDataWranglerStudyManifest(staleTemplate), /absence of retained target state/u);

  const desktopDisplay = structuredClone(manifest);
  desktopDisplay.provenance.display.mode = "current";
  assert.throws(() => validateDataWranglerStudyManifest(desktopDisplay), /headless Ozone/u);

  const missingStorageIdentity = structuredClone(manifest);
  missingStorageIdentity.provenance.storage.deviceIdentitySha256 = "unknown";
  assert.throws(() => validateDataWranglerStudyManifest(missingStorageIdentity), /device identity/u);

  const changedFixtureSchema = structuredClone(manifest);
  changedFixtureSchema.fixtures[0].schema[2].dtype = "float64";
  assert.throws(() => validateDataWranglerStudyManifest(changedFixtureSchema), /ordered Int64/u);

  const changedFixtureSentinel = structuredClone(manifest);
  changedFixtureSentinel.fixtures[0].sentinels[2].value -= 1;
  assert.throws(() => validateDataWranglerStudyManifest(changedFixtureSentinel), /three registered/u);

  const timedCapabilityProbe = structuredClone(manifest);
  timedCapabilityProbe.provenance.capabilities[0].timed = true;
  assert.throws(() => validateDataWranglerStudyManifest(timedCapabilityProbe), /capability receipt|fixture order/u);

  const missingFixtureCapability = structuredClone(manifest);
  missingFixtureCapability.provenance.capabilities.pop();
  assert.throws(() => validateDataWranglerStudyManifest(missingFixtureCapability), /one.*receipt for every fixture/u);

  const reversedFixtureCapabilities = structuredClone(manifest);
  reversedFixtureCapabilities.provenance.capabilities.reverse();
  assert.throws(() => validateDataWranglerStudyManifest(reversedFixtureCapabilities), /exact fixture order/u);

  const wrongLocale = structuredClone(manifest);
  wrongLocale.editor.uiLocale = "de";
  assert.throws(() => validateDataWranglerStudyManifest(wrongLocale), /--locale=en/u);

  const changedWrapperDigest = structuredClone(manifest);
  changedWrapperDigest.provenance.capabilities[0].receiptSha256 = "0".repeat(64);
  assert.throws(() => validateDataWranglerStudyManifest(changedWrapperDigest), /validated public-UI evidence/u);

  const changedContext = structuredClone(manifest);
  changedContext.provenance.capabilities[0].context.source.schemaSha256 = "0".repeat(64);
  assert.throws(() => validateDataWranglerStudyManifest(changedContext), /exact Polars fixture source/u);

  const coordinatedSourceForgery = structuredClone(manifest);
  const forgedCapability = coordinatedSourceForgery.provenance.capabilities[0];
  forgedCapability.context.source.schemaSha256 = "0".repeat(64);
  forgedCapability.receipt.evidence.source.schemaSha256 = "0".repeat(64);
  forgedCapability.receipt.evidenceSha256 = digestPublicUiReceiptEvidence(forgedCapability.receipt.evidence);
  forgedCapability.receiptSha256 = digestStudyValue(forgedCapability.receipt);
  assert.throws(() => validateDataWranglerStudyManifest(coordinatedSourceForgery), /exact Polars fixture source/u);

  const forgedTrace = structuredClone(manifest);
  const forgedTraceReceipt = forgedTrace.provenance.capabilities[0].receipt;
  forgedTraceReceipt.evidence.trace[1].actions[1].matchCount = 0;
  forgedTraceReceipt.evidence.trace[1].actions[1].pointerUsable = false;
  forgedTraceReceipt.evidenceSha256 = digestPublicUiReceiptEvidence(forgedTraceReceipt.evidence);
  forgedTrace.provenance.capabilities[0].receiptSha256 = digestStudyValue(forgedTraceReceipt);
  assert.throws(() => validateDataWranglerStudyManifest(forgedTrace), /first stable exact pointer-usable action/u);

  const changedControlContext = structuredClone(manifest);
  changedControlContext.provenance.controlProfile.context.captureId = "55555555-5555-4555-8555-555555555555";
  assert.throws(() => validateDataWranglerStudyManifest(changedControlContext), /expected capture ID/u);

  const changedControlDigest = structuredClone(manifest);
  changedControlDigest.provenance.controlProfile.receiptSha256 = "0".repeat(64);
  assert.throws(() => validateDataWranglerStudyManifest(changedControlDigest), /validated public-UI evidence/u);

  const extra = { ...manifest, marketingWinner: "Open Wrangler" };
  assert.throws(() => validateDataWranglerStudyManifest(extra), /missing or unknown fields/u);
});

test("pure source and cache binding validators pin the manifest fixture, copy, and toolchain", () => {
  const manifest = studyManifest();
  const scheduleEntry = manifest.schedule[0];
  const sourceCopy = studySourceCopy(manifest, scheduleEntry, 0, 0);
  const cacheProof = studyCacheProof(manifest, scheduleEntry, sourceCopy);
  assert.equal(validateDataWranglerComparisonSourceCopyBinding({ sourceCopy, manifest, scheduleEntry }), sourceCopy);
  assert.equal(
    validateDataWranglerComparisonCacheBinding({ cacheProof, sourceCopy, manifest, scheduleEntry }),
    cacheProof
  );

  const wrongFixture = structuredClone(sourceCopy);
  wrongFixture.canonicalReceipt.sha256 = "0".repeat(64);
  assert.throws(
    () => validateDataWranglerComparisonSourceCopyBinding({ sourceCopy: wrongFixture, manifest, scheduleEntry }),
    /does not match its distinct immutable fixture input/u
  );

  const wrongCopy = structuredClone(cacheProof);
  wrongCopy.proof.sourceFilesystemIdentityAfter.inode = "999999";
  assert.throws(
    () => validateDataWranglerComparisonCacheBinding({ cacheProof: wrongCopy, sourceCopy, manifest, scheduleEntry }),
    /does not bind the exact private copy/u
  );

  const wrongToolchain = structuredClone(cacheProof);
  wrongToolchain.toolchain.controller.sha256 = "9".repeat(64);
  assert.throws(
    () =>
      validateDataWranglerComparisonCacheBinding({ cacheProof: wrongToolchain, sourceCopy, manifest, scheduleEntry }),
    /manifest-pinned controller and Python toolchain/u
  );
});

test("append-only fragments resume a half pair and accept only an exact completed retry", () => {
  withTemporaryDirectory((directory) => {
    const manifest = studyManifest();
    const firstBlock = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
    const first = successFragment(manifest, firstBlock[0], 0, 10);
    const receipt = publishDataWranglerStudyFragment(directory, first, manifest);
    assert.match(receipt.sha256, /^[0-9a-f]{64}$/u);
    const repeated = publishDataWranglerStudyFragment(directory, first, manifest);
    assert.equal(repeated.status, "complete");
    const conflicting = structuredClone(first);
    conflicting.fragmentId = "44444444-4444-4444-8444-444444444444";
    assert.throws(() => publishDataWranglerStudyFragment(directory, conflicting, manifest), /digest/u);

    const loaded = loadDataWranglerStudyFragments(directory, manifest);
    assert.equal(loaded.length, 1);
    const pending = pendingDataWranglerStudyTrials(manifest, loaded);
    assert.equal(pending.length, 95);
    assert.equal(pending.filter((entry) => entry.blockId === firstBlock[0].blockId).length, 1);
    assert.equal(pending.find((entry) => entry.blockId === firstBlock[0].blockId).product, firstBlock[1].product);
    assert.equal(pending.find((entry) => entry.blockId === firstBlock[0].blockId).attempt, 0);
  });
});

test("artifact publication and fragment recording reject a parent rebind within one directory lease", async (t) => {
  await t.test("manifest publication", () => {
    withTemporaryDirectory((directory) => {
      const ledger = resolve(directory, "ledger");
      const displaced = resolve(directory, "ledger-displaced");
      mkdirSync(ledger, { mode: 0o700 });
      let directoryOpenCount = 0;
      assert.throws(
        () =>
          writeDataWranglerStudyJsonExclusive(resolve(ledger, "manifest.json"), studyManifest(), {
            faultInjector: (point) => {
              if (point === "directory-opened") {
                directoryOpenCount += 1;
              }
              if (point === "publication-recovered") {
                renameSync(ledger, displaced);
                mkdirSync(ledger, { mode: 0o700 });
              }
            }
          }),
        /parent identity changed while it was leased/u
      );
      assert.equal(directoryOpenCount, 1);
      assert.deepEqual(readdirSync(ledger), []);
      assert.deepEqual(readdirSync(displaced), []);
    });
  });

  await t.test("fragment recording", () => {
    withTemporaryDirectory((directory) => {
      const ledger = resolve(directory, "fragments");
      const displaced = resolve(directory, "fragments-displaced");
      const manifest = studyManifest();
      const fragment = successFragment(manifest, manifest.schedule[0], 0, 10);
      let directoryOpenCount = 0;
      assert.throws(
        () =>
          publishDataWranglerStudyFragment(ledger, fragment, manifest, {
            faultInjector: (point) => {
              if (point === "directory-opened") {
                directoryOpenCount += 1;
              }
              if (point === "directory-listed") {
                renameSync(ledger, displaced);
                mkdirSync(ledger, { mode: 0o700 });
              }
            }
          }),
        /parent identity changed while it was leased/u
      );
      assert.equal(directoryOpenCount, 1);
      assert.deepEqual(readdirSync(ledger), []);
      assert.deepEqual(readdirSync(displaced), []);
    });
  });
});

test("fragment loading keeps one directory lease and rejects a rebound parent", () => {
  withTemporaryDirectory((directory) => {
    const manifest = studyManifest();
    const fragment = successFragment(manifest, manifest.schedule[0], 0, 10);
    publishDataWranglerStudyFragment(directory, fragment, manifest);
    const displaced = `${directory}.displaced`;
    let rebound = false;
    assert.throws(
      () =>
        loadDataWranglerStudyFragments(directory, manifest, {
          faultInjector: (point) => {
            if (point !== "directory-opened" || rebound) {
              return;
            }
            rebound = true;
            renameSync(directory, displaced);
            mkdirSync(directory, { mode: 0o700 });
          }
        }),
      /parent identity changed while it was leased/u
    );
    assert.equal(rebound, true);
    assert.equal(readdirSync(displaced).filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(readdirSync(directory).length, 0);
  });
});

test("fragment loading rejects a directory-entry swap after opening the file", () => {
  withTemporaryDirectory((directory) => {
    const manifest = studyManifest();
    const fragment = successFragment(manifest, manifest.schedule[0], 0, 10);
    publishDataWranglerStudyFragment(directory, fragment, manifest);
    const [name] = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
    const path = resolve(directory, name);
    const displaced = `${path}.displaced`;
    let swapped = false;
    assert.throws(
      () =>
        loadDataWranglerStudyFragments(directory, manifest, {
          faultInjector: (point) => {
            if (point !== "file-opened" || swapped) {
              return;
            }
            swapped = true;
            renameSync(path, displaced);
            writeFileSync(path, readFileSync(displaced), { mode: 0o600 });
          }
        }),
      /Study fragment changed while it was read/u
    );
    assert.equal(swapped, true);
    assert.notEqual(lstatSync(path, { bigint: true }).ino, lstatSync(displaced, { bigint: true }).ino);
  });
});

test("completed trials cannot reuse an editor or configured-kernel identity", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const first = successFragment(manifest, entries[0], 0, 10, 0);
  const second = successFragment(manifest, entries[1], 0, 10, 1);
  reuseTrialProcessIdentities(second, first);

  assert.equal(validateDataWranglerStudyFragment(first, manifest), first);
  assert.equal(validateDataWranglerStudyFragment(second, manifest), second);
  assert.throws(
    () => pendingDataWranglerStudyTrials(manifest, [first, second]),
    /fresh editor and configured-kernel identities/u
  );
});

test("fragment publication enforces the exact interleaved schedule and first-then-second product order", () => {
  withTemporaryDirectory((directory) => {
    const manifest = studyManifest();
    const first = manifest.schedule[0];
    const second = manifest.schedule[1];
    const nextCell = manifest.schedule[2];
    assert.equal(first.orderInPair, 1);
    assert.equal(second.orderInPair, 2);
    assert.throws(
      () => publishDataWranglerStudyFragment(directory, successFragment(manifest, second, 0, 10, 0), manifest),
      /exact next immutable schedule/u
    );
    assert.throws(
      () => publishDataWranglerStudyFragment(directory, successFragment(manifest, nextCell, 0, 10, 0), manifest),
      /exact next immutable schedule/u
    );
    publishDataWranglerStudyFragment(directory, successFragment(manifest, first, 0, 10, 0), manifest);
    assert.throws(
      () => publishDataWranglerStudyFragment(directory, successFragment(manifest, nextCell, 0, 10, 1), manifest),
      /exact next immutable schedule/u
    );
    publishDataWranglerStudyFragment(directory, successFragment(manifest, second, 0, 10, 1), manifest);
    assert.equal(loadDataWranglerStudyFragments(directory, manifest).length, 2);
  });
});

test("a second-half pre-action failure retains the first success and schedules a correlated full-pair rerun", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const invalid = [
    successFragment(manifest, entries[0], 0, 12, 0),
    preActionInvalidFragment(manifest, entries[1], 0, 1)
  ];
  const pending = pendingDataWranglerStudyTrials(manifest, invalid);
  const rerun = pending.filter((entry) => entry.blockId === entries[0].blockId);
  assert.equal(rerun.length, 2);
  assert.ok(rerun.every((entry) => entry.attempt === 1));
  assert.ok(rerun.every((entry) => entry.effectiveBlockId.endsWith("~a01")));

  const rerunFragments = [
    ...invalid,
    successFragment(manifest, entries[0], 1, 11, 2),
    successFragment(manifest, entries[1], 1, 10, 3)
  ];
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments: rerunFragments,
    finalizedAtUtc: "2026-08-02T11:30:00.000Z"
  });
  assert.equal(result.accounting.invalidatedPairAttempts, 1);
  assert.deepEqual(
    result.fragments.map((fragment) => [fragment.executionIndex, fragment.scheduleEntryId, fragment.attempt]),
    [
      [0, entries[0].id, 0],
      [1, entries[1].id, 0],
      [2, entries[0].id, 1],
      [3, entries[1].id, 1]
    ]
  );

  const orphan = [successFragment(manifest, entries[0], 1, 12, 0)];
  assert.throws(() => pendingDataWranglerStudyTrials(manifest, orphan), /exact next immutable schedule/u);
});

test("a first-half pre-action failure skips the unmatched second run and starts a full-pair rerun", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const invalid = preActionInvalidFragment(manifest, entries[0], 0, 0);
  const pending = pendingDataWranglerStudyTrials(manifest, [invalid]);
  const rerun = pending.filter((entry) => entry.blockId === entries[0].blockId);
  assert.deepEqual(
    rerun.map((entry) => [entry.id, entry.attempt]),
    [
      [entries[0].id, 1],
      [entries[1].id, 1]
    ]
  );
  assert.deepEqual(
    pending.slice(0, 2).map((entry) => [entry.id, entry.attempt]),
    rerun.map((entry) => [entry.id, entry.attempt])
  );

  const unmatchedSecond = [invalid, successFragment(manifest, entries[1], 0, 10, 1)];
  assert.throws(() => pendingDataWranglerStudyTrials(manifest, unmatchedSecond), /exact next immutable schedule/u);

  const fragments = [
    invalid,
    successFragment(manifest, entries[0], 1, 11, 1),
    successFragment(manifest, entries[1], 1, 10, 2)
  ];
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T11:35:00.000Z"
  });
  assert.equal(result.accounting.invalidatedPairAttempts, 1);
  assert.deepEqual(
    result.fragments.map((fragment) => [fragment.executionIndex, fragment.scheduleEntryId, fragment.attempt]),
    [
      [0, entries[0].id, 0],
      [1, entries[0].id, 1],
      [2, entries[1].id, 1]
    ]
  );
});

test("fragment validation correlates manifest, scheduled identity, milestones, and bounded outcomes", () => {
  const manifest = studyManifest();
  const fragment = successFragment(manifest, manifest.schedule[0], 0, 25);
  assert.equal(fragment.protocol, DATA_WRANGLER_STUDY_FRAGMENT_PROTOCOL);
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);
  assert.throws(
    () =>
      validateDataWranglerStudyFragment(
        { ...fragment, protocol: "openwrangler-data-wrangler-study-fragment-v1" },
        manifest
      ),
    /fragment protocol/u
  );

  const fractionalMilestones = successFragment(manifest, manifest.schedule[0], 0, 25.125);
  assert.equal(validateDataWranglerStudyFragment(fractionalMilestones, manifest), fractionalMilestones);
  assert.equal(
    BigInt(fractionalMilestones.resourceObservation.terminalBoundary.targetMonotonicNanoseconds) -
      PSS_TEST_ORIGIN_NANOSECONDS,
    5_075_375_000n
  );

  assert.throws(
    () => validateDataWranglerStudyFragment({ ...fragment, manifestSha256: digest("9") }, manifest),
    /immutable manifest/u
  );
  const missingMilestone = structuredClone(fragment);
  missingMilestone.milestones.workbenchReadyMs = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingMilestone, manifest), /milestone/u);
  const badOutcome = structuredClone(fragment);
  badOutcome.outcome.reasonClass = "timeout";
  assert.throws(() => validateDataWranglerStudyFragment(badOutcome, manifest), /successful study outcome/u);

  const missingResource = structuredClone(fragment);
  missingResource.resourceObservation = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingResource, manifest), /valid resource observation/u);

  const invalidSuccessResource = structuredClone(fragment);
  invalidSuccessResource.resourceObservation.valid = false;
  invalidSuccessResource.resourceObservation.reasonClass = "resource-sampling";
  invalidSuccessResource.resourceObservation.missedSamples = 1;
  assert.throws(
    () => validateDataWranglerStudyFragment(invalidSuccessResource, manifest),
    /valid resource observation/u
  );

  const sampledOnlyIdentity = { pid: 199, startTimeTicks: "19900" };
  const sampledOnlyChild = structuredClone(fragment);
  sampledOnlyChild.resourceObservation.retainedOwnedIdentities.push(sampledOnlyIdentity);
  sampledOnlyChild.cleanupProof.retainedOwnedIdentities.push(sampledOnlyIdentity);
  const sampledOnlyProcess = {
    ...sampledOnlyIdentity,
    category: "other-owned-child",
    pssBytes: 4_096,
    rssBytes: 8_192
  };
  sampledOnlyChild.resourceObservation.samples[0].processes.push(sampledOnlyProcess);
  sampledOnlyChild.resourceObservation.samples[0].totalPssBytes += sampledOnlyProcess.pssBytes;
  sampledOnlyChild.resourceObservation.samples[0].totalRssBytes += sampledOnlyProcess.rssBytes;
  sampledOnlyChild.resourceObservation.samples[0].categories["other-owned-child"] += sampledOnlyProcess.pssBytes;
  assert.equal(
    sampledOnlyChild.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.some(
      (identity) => identity.pid === sampledOnlyIdentity.pid
    ),
    false
  );
  assert.equal(validateDataWranglerStudyFragment(sampledOnlyChild, manifest), sampledOnlyChild);

  const omittedCumulativeChildFromCleanup = structuredClone(sampledOnlyChild);
  omittedCumulativeChildFromCleanup.cleanupProof.retainedOwnedIdentities.pop();
  assert.throws(
    () => validateDataWranglerStudyFragment(omittedCumulativeChildFromCleanup, manifest),
    /canonical union of sampled and supervisor-owned identities/u
  );

  const adoptedDuringCleanup = structuredClone(fragment);
  const adoptedIdentity = { pid: 199, startTimeTicks: "19900" };
  adoptedDuringCleanup.cleanupProof.retainedOwnedIdentities.push(adoptedIdentity);
  adoptedDuringCleanup.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push({
    ...adoptedIdentity,
    disposition: "terminated"
  });
  adoptedDuringCleanup.cleanupProof.observations.splice(1, 0, {
    sequence: 1,
    elapsedMs: 100,
    processes: [adoptedIdentity]
  });
  adoptedDuringCleanup.cleanupProof.observations[2].sequence = 2;
  adoptedDuringCleanup.cleanupProof.observations[3].sequence = 3;
  assert.equal(validateDataWranglerStudyFragment(adoptedDuringCleanup, manifest), adoptedDuringCleanup);

  const simultaneousCleanupPoll = structuredClone(fragment);
  simultaneousCleanupPoll.cleanupProof.observations[1].elapsedMs = 99;
  assert.throws(
    () => validateDataWranglerStudyFragment(simultaneousCleanupPoll, manifest),
    /near-200 ms polling cadence/u
  );
  const minimumCleanupPoll = structuredClone(fragment);
  minimumCleanupPoll.cleanupProof.observations[1].elapsedMs = 100;
  assert.equal(validateDataWranglerStudyFragment(minimumCleanupPoll, manifest), minimumCleanupPoll);

  const immediatelyEmptyCleanup = structuredClone(fragment);
  immediatelyEmptyCleanup.cleanupProof.observations = [
    { sequence: 0, elapsedMs: 0, processes: [] },
    { sequence: 1, elapsedMs: 200, processes: [] }
  ];
  assert.equal(validateDataWranglerStudyFragment(immediatelyEmptyCleanup, manifest), immediatelyEmptyCleanup);

  const oneEmptyPoll = structuredClone(fragment);
  oneEmptyPoll.cleanupProof.observations.pop();
  assert.throws(
    () => validateDataWranglerStudyFragment(oneEmptyPoll, manifest),
    /two consecutive empty process-tree observations/u
  );

  const processAfterEmpty = structuredClone(fragment);
  processAfterEmpty.cleanupProof.observations.splice(2, 0, {
    sequence: 2,
    elapsedMs: 300,
    processes: [
      {
        pid: processAfterEmpty.processProofs.editorRoot.pid,
        startTimeTicks: processAfterEmpty.processProofs.editorRoot.startTimeTicks
      }
    ]
  });
  processAfterEmpty.cleanupProof.observations[3].sequence = 3;
  assert.throws(
    () => validateDataWranglerStudyFragment(processAfterEmpty, manifest),
    /cannot observe a process after the tree first becomes empty/u
  );

  const survivingCleanup = postActionFailureFragment(structuredClone(fragment), "cleanup");
  survivingCleanup.cleanupProof.status = "surviving-tree";
  survivingCleanup.cleanupProof.treeEmpty = false;
  survivingCleanup.cleanupProof.failure = { reason: "surviving-process-tree", observedAtMs: 10_000 };
  assert.throws(() => validateDataWranglerStudyFragment(survivingCleanup, manifest), /publishable cleanup proof/u);

  const reusedPid = structuredClone(fragment);
  const oldKernelIdentity = reusedPid.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.find(
    (identity) => identity.pid === reusedPid.processProofs.configuredKernel.pid
  );
  const replacementIdentity = {
    pid: oldKernelIdentity.pid,
    startTimeTicks: String(Number(oldKernelIdentity.startTimeTicks) + 1)
  };
  reusedPid.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push({
    ...replacementIdentity,
    disposition: "terminated"
  });
  reusedPid.cleanupProof.supervisorTerminalReceipt.identityReuseEvents.push({
    pid: replacementIdentity.pid,
    previousStartTimeTicks: oldKernelIdentity.startTimeTicks,
    replacementStartTimeTicks: replacementIdentity.startTimeTicks
  });
  reusedPid.cleanupProof.supervisorTerminalReceipt.supervisorExitCode = 125;
  reusedPid.cleanupProof.retainedOwnedIdentities.push(replacementIdentity);
  assert.throws(
    () => validateDataWranglerStudyFragment(reusedPid, manifest),
    /PID-reuse cleanup receipt requires a resource-sampling product failure/u
  );
  postActionFailureFragment(reusedPid, "resource-sampling");
  assert.equal(validateDataWranglerStudyFragment(reusedPid, manifest), reusedPid);

  const sequentialReuse = structuredClone(reusedPid);
  const secondReplacement = {
    pid: replacementIdentity.pid,
    startTimeTicks: String(Number(replacementIdentity.startTimeTicks) + 1)
  };
  sequentialReuse.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push({
    ...secondReplacement,
    disposition: "terminated"
  });
  sequentialReuse.cleanupProof.supervisorTerminalReceipt.identityReuseEvents.push({
    pid: secondReplacement.pid,
    previousStartTimeTicks: replacementIdentity.startTimeTicks,
    replacementStartTimeTicks: secondReplacement.startTimeTicks
  });
  sequentialReuse.cleanupProof.retainedOwnedIdentities.push(secondReplacement);
  assert.equal(validateDataWranglerStudyFragment(sequentialReuse, manifest), sequentialReuse);

  const duplicateTerminalIdentity = structuredClone(fragment);
  duplicateTerminalIdentity.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push(
    structuredClone(duplicateTerminalIdentity.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities[0])
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(duplicateTerminalIdentity, manifest),
    /repeats an owned process identity/u
  );

  const tooFewResourceSamples = structuredClone(fragment);
  tooFewResourceSamples.resourceObservation.samples = tooFewResourceSamples.resourceObservation.samples.slice(0, 4);
  assert.throws(() => validateDataWranglerStudyFragment(tooFewResourceSamples, manifest), /at least five samples/u);

  const tooManyResourceSamples = structuredClone(fragment);
  tooManyResourceSamples.resourceObservation.samples = new Array(DATA_WRANGLER_STUDY_MAXIMUM_RESOURCE_SAMPLES + 1);
  assert.throws(
    () => validateDataWranglerStudyFragment(tooManyResourceSamples, manifest),
    /fixed trial, deadline, and quiescence bound/u
  );

  const wrongClockNormalization = structuredClone(fragment);
  wrongClockNormalization.resourceObservation.samples[0].elapsedMs = 1;
  assert.throws(
    () => validateDataWranglerStudyFragment(wrongClockNormalization, manifest),
    /exact monotonic normalization/u
  );

  const wrongLatenessBound = structuredClone(fragment);
  wrongLatenessBound.resourceObservation.maximumLatenessMs = 199;
  assert.throws(() => validateDataWranglerStudyFragment(wrongLatenessBound, manifest), /preregistered lateness bound/u);

  const tamperedSupervisorHash = structuredClone(fragment);
  tamperedSupervisorHash.resourceObservation.ownershipTracker.supervisorSource.sha256 = "not-a-sha256";
  assert.throws(() => validateDataWranglerStudyFragment(tamperedSupervisorHash, manifest), /source SHA-256/u);

  const substitutedSupervisorHash = structuredClone(fragment);
  substitutedSupervisorHash.resourceObservation.ownershipTracker.supervisorSource.sha256 = "0".repeat(64);
  assert.throws(() => validateDataWranglerStudyFragment(substitutedSupervisorHash, manifest), /manifest-pinned/u);

  const unverifiedSubreaper = structuredClone(fragment);
  unverifiedSubreaper.resourceObservation.ownershipTracker.supervisor.subreaperVerified = false;
  assert.throws(() => validateDataWranglerStudyFragment(unverifiedSubreaper, manifest), /subreaper/u);

  const substitutedSupervisorIdentity = structuredClone(fragment);
  substitutedSupervisorIdentity.resourceObservation.ownershipTracker.supervisorSource.filesystemIdentity.inode = "43";
  assert.throws(() => validateDataWranglerStudyFragment(substitutedSupervisorIdentity, manifest), /manifest-pinned/u);

  const substitutedInvocationPolicy = structuredClone(fragment);
  substitutedInvocationPolicy.resourceObservation.ownershipTracker.invocationPolicySha256 = "0".repeat(64);
  assert.throws(() => validateDataWranglerStudyFragment(substitutedInvocationPolicy, manifest), /manifest-pinned/u);

  const reusedSupervisorPid = structuredClone(fragment);
  reusedSupervisorPid.resourceObservation.ownershipTracker.supervisor.pid =
    reusedSupervisorPid.resourceObservation.ownershipTracker.editorRoot.pid;
  assert.throws(() => validateDataWranglerStudyFragment(reusedSupervisorPid, manifest), /dedicated process group/u);

  const wrongSupervisorEditorPid = structuredClone(fragment);
  wrongSupervisorEditorPid.resourceObservation.ownershipTracker.editorRoot.pid += 1;
  wrongSupervisorEditorPid.resourceObservation.ownershipTracker.editorRoot.processGroupId += 1;
  wrongSupervisorEditorPid.resourceObservation.ownershipTracker.editorRoot.sessionId += 1;
  assert.throws(
    () => validateDataWranglerStudyFragment(wrongSupervisorEditorPid, manifest),
    /supervisor-receipt editor root|editor root captured/u
  );

  const missedResourceSample = structuredClone(fragment);
  missedResourceSample.resourceObservation.samples.splice(3, 1);
  assert.throws(() => validateDataWranglerStudyFragment(missedResourceSample, manifest), /non-missed 200 ms cadence/u);

  const incompleteResourceBoundary = structuredClone(fragment);
  incompleteResourceBoundary.resourceObservation.samples.pop();
  assert.throws(
    () => validateDataWranglerStudyFragment(incompleteResourceBoundary, manifest),
    /terminal (?:evidence|sampling boundary)/u
  );

  const lateTerminalBoundary = structuredClone(fragment);
  const lateTerminalScheduledMs = fragment.milestones.samplingStoppedMs - 2;
  lateTerminalBoundary.resourceObservation.terminalBoundary = pssTerminalBoundary(
    lateTerminalScheduledMs + PSS_TEST_SAMPLE_START_DELAY_MS - 400,
    lateTerminalScheduledMs
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(lateTerminalBoundary, manifest),
    /bounded overshoot|first eligible sample/u
  );

  const wrongSuccessTarget = structuredClone(fragment);
  const shiftedTargetMs = fragment.milestones.profilesCompleteMs + 2_001;
  wrongSuccessTarget.resourceObservation.terminalBoundary = pssTerminalBoundary(
    shiftedTargetMs,
    pssTerminalScheduledMs(fragment.milestones.profilesCompleteMs + 2_000)
  );
  assert.throws(() => validateDataWranglerStudyFragment(wrongSuccessTarget, manifest), /bind profile completion/u);

  const continuedPastFirstEligibleSample = successFragment(manifest, manifest.schedule[0], 0, 200, 0);
  const continuedTargetMs = continuedPastFirstEligibleSample.milestones.profilesCompleteMs + 2_000;
  const extraSampleScheduledMs = pssTerminalScheduledMs(continuedTargetMs) + 200;
  const extraSample = fragmentPssSample(extraSampleScheduledMs, continuedPastFirstEligibleSample.processProofs);
  continuedPastFirstEligibleSample.resourceObservation.samples.push(extraSample);
  continuedPastFirstEligibleSample.milestones.samplingStoppedMs = extraSample.elapsedMs;
  continuedPastFirstEligibleSample.resourceObservation.terminalBoundary = pssTerminalBoundary(
    continuedTargetMs,
    extraSampleScheduledMs
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(continuedPastFirstEligibleSample, manifest),
    /first eligible sample/u
  );

  const wrongCache = structuredClone(fragment);
  wrongCache.cacheProof.proof.requestedState = "evicted";
  assert.throws(() => validateDataWranglerStudyFragment(wrongCache, manifest), /scheduled warm\/cold/u);

  const missingSourceCopy = structuredClone(fragment);
  missingSourceCopy.sourceCopy = null;
  assert.throws(
    () => validateDataWranglerStudyFragment(missingSourceCopy, manifest),
    /requires its private source-copy/u
  );

  const aliasedSourceCopy = structuredClone(fragment);
  aliasedSourceCopy.sourceCopy.copyReceipt.filesystemIdentity = structuredClone(
    aliasedSourceCopy.sourceCopy.canonicalReceipt.filesystemIdentity
  );
  assert.throws(() => validateDataWranglerStudyFragment(aliasedSourceCopy, manifest), /distinct immutable fixture/u);

  const wrongSourceCopyDigest = structuredClone(fragment);
  wrongSourceCopyDigest.sourceCopy.copyReceipt.sha256 = digest("0");
  assert.throws(
    () => validateDataWranglerStudyFragment(wrongSourceCopyDigest, manifest),
    /distinct immutable fixture/u
  );

  const wrongSourceCopyCleanup = structuredClone(fragment);
  wrongSourceCopyCleanup.sourceCopy.cleanup.copyReceipt.filesystemIdentity.inode = "9999";
  assert.throws(() => validateDataWranglerStudyFragment(wrongSourceCopyCleanup, manifest), /copied inode/u);

  const missingSourceCopyProvenance = structuredClone(fragment);
  delete missingSourceCopyProvenance.trialProvenance.sourceCopyAfter;
  assert.throws(
    () => validateDataWranglerStudyFragment(missingSourceCopyProvenance, manifest),
    /missing or unknown fields/u
  );

  const wrongCachePageCount = structuredClone(fragment);
  wrongCachePageCount.cacheProof.proof.totalPages += 1;
  wrongCachePageCount.cacheProof.proof.residentPagesAfter += 1;
  assert.throws(() => validateDataWranglerStudyFragment(wrongCachePageCount, manifest), /private copy byte size/u);

  const missingActionCache = structuredClone(fragment);
  missingActionCache.cacheProof = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingActionCache, manifest), /missing source-cache proof/u);

  const wrongKernel = structuredClone(fragment);
  wrongKernel.processProofs.configuredKernel.executableSha256 = digest("f");
  assert.throws(() => validateDataWranglerStudyFragment(wrongKernel, manifest), /manifest-pinned Python/u);

  const missingSourcePostcheck = structuredClone(fragment);
  missingSourcePostcheck.engineEvidence.sourceVerification.receipt.observedAfterTrial = "not-reached";
  assert.throws(() => validateDataWranglerStudyFragment(missingSourcePostcheck, manifest), /source postcheck/u);

  const wrongSourceReceipt = structuredClone(fragment);
  wrongSourceReceipt.engineEvidence.sourceVerification.receipt.rowCount -= 1;
  resignSourceReceipt(wrongSourceReceipt);
  assert.throws(() => validateDataWranglerStudyFragment(wrongSourceReceipt, manifest), /exact manifest fixture/u);

  const wrongSourceFixture = structuredClone(fragment);
  wrongSourceFixture.engineEvidence.sourceVerification.receipt.fixtureSha256 = digest("0");
  resignSourceReceipt(wrongSourceFixture);
  assert.throws(() => validateDataWranglerStudyFragment(wrongSourceFixture, manifest), /exact manifest fixture/u);

  const wrongSourceSchema = structuredClone(fragment);
  wrongSourceSchema.engineEvidence.sourceVerification.receipt.schema[1].name = "other";
  resignSourceReceipt(wrongSourceSchema);
  assert.throws(() => validateDataWranglerStudyFragment(wrongSourceSchema, manifest), /exact manifest fixture/u);

  const wrongSourceSentinel = structuredClone(fragment);
  wrongSourceSentinel.engineEvidence.sourceVerification.receipt.sentinelsAfter[1].value = 999;
  resignSourceReceipt(wrongSourceSentinel);
  assert.throws(() => validateDataWranglerStudyFragment(wrongSourceSentinel, manifest), /source postcheck/u);

  const changedSourceIdentity = structuredClone(fragment);
  changedSourceIdentity.engineEvidence.sourceVerification.receipt.filesystemIdentityAfter.inode = "9999";
  resignSourceReceipt(changedSourceIdentity);
  assert.throws(() => validateDataWranglerStudyFragment(changedSourceIdentity, manifest), /source postcheck/u);

  const wrongCacheFixture = structuredClone(fragment);
  wrongCacheFixture.cacheProof.proof.sourceFilesystemIdentityBefore.inode =
    wrongCacheFixture.sourceCopy.canonicalReceipt.filesystemIdentity.inode;
  assert.throws(() => validateDataWranglerStudyFragment(wrongCacheFixture, manifest), /exact private copy/u);

  const changedCacheIdentity = structuredClone(fragment);
  changedCacheIdentity.cacheProof.proof.sourceFilesystemIdentityAfter.inode = "9999";
  assert.throws(() => validateDataWranglerStudyFragment(changedCacheIdentity, manifest), /exact private copy/u);

  const wrongEditorRoot = structuredClone(fragment);
  wrongEditorRoot.processProofs.editorRoot.pid = 999;
  assert.throws(
    () => validateDataWranglerStudyFragment(wrongEditorRoot, manifest),
    /exact editor root|editor root captured/u
  );

  const incompleteCleanup = structuredClone(fragment);
  incompleteCleanup.cleanupProof.observations.at(-1).processes = [{ pid: 100, startTimeTicks: "12345" }];
  assert.throws(
    () => validateDataWranglerStudyFragment(incompleteCleanup, manifest),
    /cannot observe a process after the tree first becomes empty/u
  );

  const missingRuntimeProof = structuredClone(fragment);
  missingRuntimeProof.processProofs.openWranglerRuntime.status =
    fragment.product === "open-wrangler" ? "not-applicable" : "live-kernel-absence-proven";
  assert.throws(
    () => validateDataWranglerStudyFragment(missingRuntimeProof, manifest),
    /require an observed runtime|Only an Open Wrangler trial/u
  );

  const changedCandidateAfter = structuredClone(fragment);
  changedCandidateAfter.trialProvenance.candidateAfter.sha256 = digest("0");
  assert.throws(() => validateDataWranglerStudyFragment(changedCandidateAfter, manifest), /manifest-pinned VSIX/u);

  const missingPostCleanupRevalidation = structuredClone(fragment);
  missingPostCleanupRevalidation.trialProvenance.revalidatedAfterCleanup = false;
  assert.throws(
    () => validateDataWranglerStudyFragment(missingPostCleanupRevalidation, manifest),
    /revalidated after/u
  );

  const extraSourceField = structuredClone(fragment);
  extraSourceField.sourceLoad.sourcePath = "/private/source.csv";
  assert.throws(() => validateDataWranglerStudyFragment(extraSourceField, manifest), /missing or unknown fields/u);

  const gateFailure = preActionInvalidFragment(manifest, manifest.schedule[0], 0, 0);
  assert.equal(gateFailure.cacheProof, null);
  assert.equal(validateDataWranglerStudyFragment(gateFailure, manifest), gateFailure);
  gateFailure.cacheProof = studyCacheProof(
    manifest,
    manifest.schedule[0],
    studySourceCopy(manifest, manifest.schedule[0], 0, 0)
  );
  assert.throws(() => validateDataWranglerStudyFragment(gateFailure, manifest), /cannot follow/u);

  const overloadedGate = structuredClone(fragment);
  overloadedGate.environmentGate.attempts[0].summary.meanNonIdleCpuPercent = 11;
  assert.throws(() => validateDataWranglerStudyFragment(overloadedGate, manifest), /summary does not match/u);

  const affinityDrift = structuredClone(fragment);
  affinityDrift.environmentGate.attempts[0].summary.affinityMatched = false;
  for (const interval of affinityDrift.environmentGate.attempts[0].intervals) {
    interval.affinityMatched = false;
  }
  assert.throws(() => validateDataWranglerStudyFragment(affinityDrift, manifest), /failure codes omit/u);

  const wrongUtilizationProcessors = structuredClone(fragment);
  wrongUtilizationProcessors.environmentGate.attempts[0].summary.cpuIds = [0, 1];
  assert.throws(
    () => validateDataWranglerStudyFragment(wrongUtilizationProcessors, manifest),
    /manifest-pinned cpuN lines/u
  );

  const missingThermalCounter = structuredClone(fragment);
  missingThermalCounter.environmentGate.provenance.power.thermalThrottleCounters = [];
  missingThermalCounter.environmentGate.attempts[0].summary.thermalThrottleDeltas = [];
  assert.throws(() => validateDataWranglerStudyFragment(missingThermalCounter, manifest), /one to 256 counters/u);

  const inventedProvenanceDrift = structuredClone(fragment);
  inventedProvenanceDrift.environmentGate.attempts[0].passed = false;
  inventedProvenanceDrift.environmentGate.attempts[0].failureCodes = ["provenance-drift"];
  inventedProvenanceDrift.environmentGate.passed = false;
  inventedProvenanceDrift.environmentGate.acceptedAttempt = null;
  inventedProvenanceDrift.environmentGate.terminalFailure = "deadline-no-complete-window";
  assert.throws(() => validateDataWranglerStudyFragment(inventedProvenanceDrift, manifest), /condition absent/u);

  const derivedProvenanceDrift = preActionInvalidFragment(manifest, manifest.schedule[0], 0, 0);
  derivedProvenanceDrift.environmentGate.provenance.kernelRelease = "6.99.0-observed";
  for (const attempt of derivedProvenanceDrift.environmentGate.attempts) {
    attempt.failureCodes.unshift("provenance-drift");
  }
  assert.equal(validateDataWranglerStudyFragment(derivedProvenanceDrift, manifest), derivedProvenanceDrift);
  const omittedProvenanceDrift = structuredClone(derivedProvenanceDrift);
  omittedProvenanceDrift.environmentGate.attempts[0].failureCodes.shift();
  assert.throws(() => validateDataWranglerStudyFragment(omittedProvenanceDrift, manifest), /failure codes omit/u);
  const malformedProvenanceDrift = structuredClone(derivedProvenanceDrift);
  malformedProvenanceDrift.environmentGate.provenance.kernelRelease = null;
  assert.throws(() => validateDataWranglerStudyFragment(malformedProvenanceDrift, manifest), /bounded single-line/u);

  const missingGateHistory = structuredClone(fragment);
  missingGateHistory.environmentGate.attempts = [];
  missingGateHistory.environmentGate.waitMs = 0;
  assert.throws(() => validateDataWranglerStudyFragment(missingGateHistory, manifest), /one to thirty complete/u);

  const actualGateOffsets = structuredClone(fragment);
  actualGateOffsets.environmentGate.attempts[0].startedAtOffsetMs = 123;
  actualGateOffsets.environmentGate.attempts[0].durationMs = 10_020;
  actualGateOffsets.environmentGate.attempts[0].intervals.at(-1).elapsedMs = 10_020;
  actualGateOffsets.environmentGate.attempts[0].intervals.at(-1).durationMs = 1_020;
  actualGateOffsets.environmentGate.waitMs = 10_143;
  assert.equal(validateDataWranglerStudyFragment(actualGateOffsets, manifest), actualGateOffsets);

  const wrongShape = structuredClone(fragment);
  wrongShape.uiEvidence.workbench.rowCount -= 1;
  assert.throws(() => validateDataWranglerStudyFragment(wrongShape, manifest), /full-source and scroll boundary/u);

  const wrongPreviewValue = structuredClone(fragment);
  wrongPreviewValue.uiEvidence.inline.preview.firstRows[0].c00 = 1;
  assert.throws(() => validateDataWranglerStudyFragment(wrongPreviewValue, manifest), /canonical synthetic values/u);

  const wrongSurfaceOwner = structuredClone(fragment);
  wrongSurfaceOwner.uiEvidence.inline.surfaceOwner =
    fragment.product === "open-wrangler" ? "data-wrangler" : "open-wrangler";
  assert.throws(() => validateDataWranglerStudyFragment(wrongSurfaceOwner, manifest), /surface ownership/u);

  const staleWorkbench = structuredClone(fragment);
  staleWorkbench.uiEvidence.workbench.newlyOpenedTarget = false;
  assert.throws(() => validateDataWranglerStudyFragment(staleWorkbench, manifest), /scroll boundary/u);

  const unchangedScroll = structuredClone(fragment);
  unchangedScroll.uiEvidence.workbench.scroll.afterC00 = 0;
  assert.throws(() => validateDataWranglerStudyFragment(unchangedScroll, manifest), /scroll boundary/u);

  const wrongProfileMinimum = structuredClone(fragment);
  wrongProfileMinimum.uiEvidence.profiles.columns[0].minimum = 1;
  assert.throws(() => validateDataWranglerStudyFragment(wrongProfileMinimum, manifest), /correctness oracle/u);

  const missingScroll = structuredClone(fragment);
  missingScroll.uiEvidence.workbench.scroll = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingScroll, manifest), /must be an object/u);

  const approximate = structuredClone(fragment);
  approximate.uiEvidence = successfulUiEvidence(manifest, manifest.schedule[0], "approximate");
  approximate.uiEvidence.profiles.columns[0].distinct.upperBound += 10;
  assert.equal(validateDataWranglerStudyFragment(approximate, manifest), approximate);
  approximate.uiEvidence.profiles.columns[0].distinct.upperBound =
    fixtureForEntry(manifest, manifest.schedule[0]).rows - 1;
  assert.throws(() => validateDataWranglerStudyFragment(approximate, manifest), /numeric limits containing/u);

  const unqualifiedApproximate = structuredClone(fragment);
  unqualifiedApproximate.uiEvidence = successfulUiEvidence(manifest, manifest.schedule[0], "approximate-unqualified");
  assert.equal(validateDataWranglerStudyFragment(unqualifiedApproximate, manifest), unqualifiedApproximate);
  unqualifiedApproximate.uiEvidence.profiles.columns[0].distinct.includedInSemanticEquivalence = true;
  assert.throws(() => validateDataWranglerStudyFragment(unqualifiedApproximate, manifest), /explicitly excluded/u);

  const exactCountOnly = structuredClone(fragment);
  exactCountOnly.uiEvidence.profiles.columns[0].distinct.percent = null;
  assert.equal(validateDataWranglerStudyFragment(exactCountOnly, manifest), exactCountOnly);

  const exactPercentOnly = structuredClone(fragment);
  exactPercentOnly.uiEvidence.profiles.columns[0].distinct.count = null;
  assert.equal(validateDataWranglerStudyFragment(exactPercentOnly, manifest), exactPercentOnly);

  const missingPercent = structuredClone(fragment);
  missingPercent.uiEvidence.profiles.columns[0].missing.semantics = "exact-percent";
  assert.equal(validateDataWranglerStudyFragment(missingPercent, manifest), missingPercent);
});

test(
  "a real Linux supervisor receipt and proc sampler bridge into fragment cleanup validation",
  {
    skip: process.platform !== "linux" || STUDY_PYTHON_312 === undefined,
    timeout: 20_000
  },
  async () => {
    const privateRoot = mkdtempSync(resolve(tmpdir(), "ow-study-real-ownership-"));
    chmodSync(privateRoot, 0o700);
    const payloadPath = resolve(privateRoot, "payload.py");
    const statePath = resolve(privateRoot, "state.json");
    writeFileSync(
      payloadPath,
      [
        "import json",
        "import os",
        "import subprocess",
        "import sys",
        "import time",
        "if len(sys.argv) == 2 and sys.argv[1] == '--child':",
        "    while True:",
        "        time.sleep(1)",
        "child = subprocess.Popen([sys.executable, __file__, '--child'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "temporary = sys.argv[1] + '.tmp'",
        "with open(temporary, 'w', encoding='utf-8') as output:",
        "    json.dump({'childPid': child.pid}, output, separators=(',', ':'))",
        "    output.flush()",
        "    os.fsync(output.fileno())",
        "os.replace(temporary, sys.argv[1])",
        "while True:",
        "    time.sleep(1)"
      ].join("\n"),
      { encoding: "utf8", mode: 0o600 }
    );
    const environment = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined));
    const environmentReceipt = Object.entries(environment).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    );
    const environmentSha256 = createHash("sha256").update(JSON.stringify(environmentReceipt), "utf8").digest("hex");
    const nonce = digestStudyValue([process.pid, privateRoot]);
    const supervisor = spawn(
      STUDY_PYTHON_312,
      [
        STUDY_SUPERVISOR_PATH,
        "--protocol",
        "openwrangler-linux-study-supervisor-v1",
        "--nonce",
        nonce,
        "--receipt-fd",
        "3",
        "--payload-environment-sha256",
        environmentSha256,
        "--",
        STUDY_PYTHON_312,
        payloadPath,
        statePath
      ],
      { env: environment, stdio: ["ignore", "ignore", "pipe", "pipe"] }
    );
    const closePromise = once(supervisor, "close");
    const receiptLines = createInterface({ input: supervisor.stdio[3], crlfDelay: Infinity });
    const receiptIterator = receiptLines[Symbol.asyncIterator]();
    let stderr = "";
    supervisor.stderr.setEncoding("utf8");
    supervisor.stderr.on("data", (chunk) => {
      stderr += chunk;
      assert.ok(Buffer.byteLength(stderr, "utf8") <= 4_096);
    });
    let terminalIdentities = [];
    try {
      const launchFrame = await receiptIterator.next();
      assert.equal(launchFrame.done, false, stderr);
      const launchReceipt = JSON.parse(launchFrame.value);
      const payloadState = await waitForStudyBridgeState(statePath);
      const childIdentity = readStudyBridgeProcIdentity(payloadState.childPid);
      assert.notEqual(childIdentity, null);
      const sampler = new LinuxPssTreeSampler({
        supervisorPid: launchReceipt.supervisor.pid,
        supervisorStartTimeTicks: launchReceipt.supervisor.startTimeTicks,
        editorRootPid: launchReceipt.editorRoot.pid,
        editorRootStartTimeTicks: launchReceipt.editorRoot.startTimeTicks,
        ownershipReceipt: launchReceipt,
        classify: ({ pid }) =>
          pid === launchReceipt.editorRoot.pid
            ? "editor-main"
            : pid === childIdentity.pid
              ? "configured-kernel"
              : "other-owned-child"
      });
      const scheduledMonotonicNanoseconds = sampler.readClockNanoseconds();
      const sample = sampler.sample({ scheduledMonotonicNanoseconds });
      assert.equal(
        sample.processes.some(
          (processIdentity) =>
            processIdentity.pid === childIdentity.pid && processIdentity.startTimeTicks === childIdentity.startTimeTicks
        ),
        true
      );
      const sampledIdentities = sampler.retainedOwnedIdentities();

      supervisor.kill("SIGTERM");
      const [terminalFrame, [exitCode, closeSignal]] = await Promise.all([receiptIterator.next(), closePromise]);
      assert.equal(terminalFrame.done, false);
      const terminalReceipt = JSON.parse(terminalFrame.value);
      assert.equal(closeSignal, null);
      assert.equal(exitCode, terminalReceipt.supervisorExitCode);
      assert.equal(stderr, "");
      assert.deepEqual(terminalReceipt.identityReuseEvents, []);
      terminalIdentities = terminalReceipt.retainedOwnedIdentities;

      const ownershipProvenance = {
        protocol: launchReceipt.protocol,
        supervisorSource: structuredClone(launchReceipt.supervisorSource),
        pythonExecutable: structuredClone(launchReceipt.pythonExecutable),
        invocationPolicySha256: launchReceipt.invocationPolicySha256
      };
      const manifest = studyManifest("available", ownershipProvenance);
      const scheduleEntry = manifest.schedule[0];
      const fragment = postActionFailureFragment(
        successFragment(manifest, scheduleEntry, 0, 25, 0),
        "resource-sampling"
      );
      fragment.processProofs.editorRoot = {
        pid: launchReceipt.editorRoot.pid,
        startTimeTicks: launchReceipt.editorRoot.startTimeTicks,
        capturedAtLaunch: true
      };
      fragment.processProofs.configuredKernel.pid = childIdentity.pid;
      fragment.processProofs.configuredKernel.startTimeTicks = childIdentity.startTimeTicks;
      fragment.trialProvenance.editorProcess = {
        pid: launchReceipt.editorRoot.pid,
        startTimeTicks: launchReceipt.editorRoot.startTimeTicks
      };
      fragment.trialProvenance.kernelProcess.pid = childIdentity.pid;
      fragment.trialProvenance.kernelProcess.startTimeTicks = childIdentity.startTimeTicks;
      fragment.resourceObservation = {
        protocol: "openwrangler-linux-pss-observation-v1",
        clock: sampler.clockReceipt(),
        ownershipTracker: launchReceipt,
        valid: false,
        reasonClass: "resource-sampling",
        intervalMs: 200,
        maximumLatenessMs: 50,
        missedSamples: 1,
        terminalBoundary: null,
        retainedOwnedIdentities: sampledIdentities,
        samples: [sample]
      };
      const cleanupIdentities = [
        ...new Map(
          [...sampledIdentities, ...terminalReceipt.retainedOwnedIdentities].map((identity) => [
            `${identity.pid}:${identity.startTimeTicks}`,
            { pid: identity.pid, startTimeTicks: identity.startTimeTicks }
          ])
        ).values()
      ].sort(
        (left, right) => left.pid - right.pid || (BigInt(left.startTimeTicks) < BigInt(right.startTimeTicks) ? -1 : 1)
      );
      fragment.cleanupProof = {
        editorRootPid: launchReceipt.editorRoot.pid,
        editorRootStartTimeTicks: launchReceipt.editorRoot.startTimeTicks,
        startedAfterTrial: true,
        intervalMs: 200,
        deadlineMs: 10_000,
        retainedOwnedIdentities: cleanupIdentities,
        supervisorTerminalReceipt: terminalReceipt,
        observations: [
          { sequence: 0, elapsedMs: 0, processes: structuredClone(cleanupIdentities) },
          { sequence: 1, elapsedMs: 200, processes: [] }
        ],
        treeEmpty: true,
        status: "complete",
        failure: null
      };
      assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);
    } finally {
      receiptLines.close();
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill("SIGTERM");
        await Promise.race([closePromise, new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
      }
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
      for (const identity of terminalIdentities) terminateStudyBridgeIdentity(identity);
      rmSync(privateRoot, { recursive: true, force: true });
    }
  }
);

test("Open Wrangler success proves an observed runtime or explicit live-kernel absence", () => {
  const manifest = studyManifest();
  const entry = manifest.schedule.find((candidate) => candidate.product === "open-wrangler");
  const absent = successFragment(manifest, entry, 0, 10, entry.sequence);
  assert.equal(absent.processProofs.openWranglerRuntime.status, "live-kernel-absence-proven");
  assert.equal(validateDataWranglerStudyFragment(absent, manifest), absent);

  const observed = structuredClone(absent);
  observed.processProofs.openWranglerRuntime = { status: "observed", pid: 102, startTimeTicks: "67890" };
  observed.resourceObservation.samples[0].processes.push({
    pid: 102,
    startTimeTicks: "67890",
    category: "open-wrangler-runtime",
    pssBytes: 0,
    rssBytes: 0
  });
  observed.resourceObservation.retainedOwnedIdentities.push({
    pid: 102,
    startTimeTicks: "67890"
  });
  observed.cleanupProof.retainedOwnedIdentities.push({ pid: 102, startTimeTicks: "67890" });
  observed.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push({
    pid: 102,
    startTimeTicks: "67890",
    disposition: "exited"
  });
  assert.equal(validateDataWranglerStudyFragment(observed, manifest), observed);

  const contradictedAbsence = structuredClone(absent);
  contradictedAbsence.resourceObservation.samples[0].processes.push({
    pid: 102,
    startTimeTicks: "67890",
    category: "open-wrangler-runtime",
    pssBytes: 0,
    rssBytes: 0
  });
  contradictedAbsence.resourceObservation.retainedOwnedIdentities.push({
    pid: 102,
    startTimeTicks: "67890"
  });
  contradictedAbsence.cleanupProof.retainedOwnedIdentities.push({ pid: 102, startTimeTicks: "67890" });
  contradictedAbsence.cleanupProof.supervisorTerminalReceipt.retainedOwnedIdentities.push({
    pid: 102,
    startTimeTicks: "67890",
    disposition: "exited"
  });
  assert.throws(() => validateDataWranglerStudyFragment(contradictedAbsence, manifest), /contradicts/u);

  const unverifiedOpenWorkbench = structuredClone(absent);
  unverifiedOpenWorkbench.engineEvidence.workbenchEngine = "unverified";
  unverifiedOpenWorkbench.engineEvidence.workbenchVerification = "not-observed";
  assert.throws(
    () => validateDataWranglerStudyFragment(unverifiedOpenWorkbench, manifest),
    /product-specific public verification/u
  );

  const dataWranglerEntry = manifest.schedule.find(
    (candidate) => candidate.product === "data-wrangler" && candidate.engine === "pandas"
  );
  const unverifiedDataWranglerWorkbench = successFragment(
    manifest,
    dataWranglerEntry,
    0,
    10,
    dataWranglerEntry.sequence
  );
  unverifiedDataWranglerWorkbench.engineEvidence.workbenchEngine = "unverified";
  unverifiedDataWranglerWorkbench.engineEvidence.workbenchVerification = "not-observed";
  unverifiedDataWranglerWorkbench.uiEvidence.workbench.engineLabel = "not-shown";
  assert.equal(
    validateDataWranglerStudyFragment(unverifiedDataWranglerWorkbench, manifest),
    unverifiedDataWranglerWorkbench
  );
});

test("the three journey deadlines accept the boundary and reject one millisecond beyond it", () => {
  const manifest = studyManifest();
  const fragment = deadlineBoundaryFragment(manifest, manifest.schedule[0]);
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);

  for (const [key, message] of [
    ["inlineReadyMs", /Inline preview readiness exceeds/u],
    ["workbenchReadyMs", /Workbench open readiness exceeds/u],
    ["profilesCompleteMs", /Complete profile readiness exceeds/u]
  ]) {
    const late = structuredClone(fragment);
    late.milestones[key] += 1;
    assert.throws(() => validateDataWranglerStudyFragment(late, manifest), message);
  }
});

test("unmeasured control and transition gaps accept 3000 ms and reject one millisecond more", () => {
  const manifest = studyManifest();
  const fragment = deadlineBoundaryFragment(manifest, manifest.schedule[0]);
  assert.equal(
    fragment.milestones.inlineActionMs +
      (fragment.milestones.workbenchActionMs - fragment.milestones.inlineReadyMs) +
      (fragment.milestones.profileActionMs - fragment.milestones.workbenchReadyMs),
    DATA_WRANGLER_STUDY_CONTROL_ALLOWANCE_MS
  );
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);

  const overAllowance = structuredClone(fragment);
  overAllowance.milestones.profileActionMs += 1;
  assert.throws(
    () => validateDataWranglerStudyFragment(overAllowance, manifest),
    /unmeasured control and transition gaps exceed/u
  );
});

test("product timeouts name the journey and retain an exact >= deadline right-censor", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.slice(0, 2);
  const timeout = timeoutFragment(manifest, entries[0], 0);
  assert.equal(validateDataWranglerStudyFragment(timeout, manifest), timeout);

  const missingTimeoutKernel = structuredClone(timeout);
  missingTimeoutKernel.processProofs.configuredKernel = null;
  missingTimeoutKernel.processProofs.openWranglerRuntime = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingTimeoutKernel, manifest), /started product action/u);

  const missingTimeoutResource = structuredClone(timeout);
  missingTimeoutResource.resourceObservation = null;
  assert.throws(() => validateDataWranglerStudyFragment(missingTimeoutResource, manifest), /launched study fragment/u);

  const explicitlyInvalidResource = structuredClone(timeout);
  explicitlyInvalidResource.resourceObservation.valid = false;
  explicitlyInvalidResource.resourceObservation.reasonClass = "resource-sampling";
  explicitlyInvalidResource.resourceObservation.missedSamples = 1;
  explicitlyInvalidResource.resourceObservation.terminalBoundary = null;
  explicitlyInvalidResource.resourceObservation.samples = [];
  assert.equal(validateDataWranglerStudyFragment(explicitlyInvalidResource, manifest), explicitlyInvalidResource);

  const belowDeadline = structuredClone(timeout);
  belowDeadline.outcome.timeout.rightCensored.valueMs = DATA_WRANGLER_STUDY_DEADLINES_MS["inline-preview"] - 1;
  assert.throws(() => validateDataWranglerStudyFragment(belowDeadline, manifest), /right-censored at >=/u);

  const wrongDeadline = structuredClone(timeout);
  wrongDeadline.outcome.timeout.deadlineMs = 44_999;
  assert.throws(() => validateDataWranglerStudyFragment(wrongDeadline, manifest), /preregistered journey deadline/u);

  const observedTooEarly = structuredClone(timeout);
  observedTooEarly.outcome.timeout.observedAtMs =
    observedTooEarly.milestones.inlineActionMs + observedTooEarly.outcome.timeout.deadlineMs - 1;
  assert.throws(() => validateDataWranglerStudyFragment(observedTooEarly, manifest), /action-plus-deadline boundary/u);

  const fragments = [timeout, successFragment(manifest, entries[1], 0, 10, 1)];
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T11:45:00.000Z"
  });
  const cell = result.cells.find((candidate) => candidate.cellId === entries[0].cellId);
  assert.equal(result.accounting.retainedTimeoutFragments, 1);
  assert.equal(result.accounting.analyzedRightCensoredMeasurements, 1);
  assert.equal(cell[`${entries[0].product === "open-wrangler" ? "openWrangler" : "dataWrangler"}Timeouts`], 1);
  assert.equal(cell.sourcePostcheckNotReached, 1);
  assert.deepEqual(cell.rightCensoredTimeouts, [
    {
      effectiveBlockId: timeout.effectiveBlockId,
      product: timeout.product,
      journey: "inline-preview",
      deadlineMs: 45_000,
      actionAtMs: 1_000,
      observedAtMs: 46_000,
      operator: ">=",
      valueMs: 45_000
    }
  ]);
  assert.equal(validateDataWranglerStudyResult(result), result);
});

test("a launched pre-action invalidation retains an explicit resource observation", () => {
  const manifest = studyManifest();
  const entry = manifest.schedule.find((candidate) => candidate.product === "data-wrangler");
  const fragment = successFragment(manifest, entry, 0, 10, 0);
  fragment.outcome = {
    status: "pre-action-invalid",
    reasonClass: "setup",
    actionStarted: false,
    correctness: "not-reached",
    timeout: null,
    unsupported: null
  };
  fragment.milestones = createEmptyStudyMilestones();
  fragment.sourceLoad = {
    status: "not-reached",
    durationMs: null,
    includedInInlineTiming: entry.kind === "cold"
  };
  fragment.engineEvidence = null;
  fragment.uiEvidence = null;
  fragment.resourceObservation.valid = false;
  fragment.resourceObservation.reasonClass = "resource-sampling";
  fragment.resourceObservation.missedSamples = 1;
  fragment.resourceObservation.terminalBoundary = null;
  fragment.resourceObservation.samples = [];
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);

  const missingResourceObservation = structuredClone(fragment);
  missingResourceObservation.resourceObservation = null;
  assert.throws(
    () => validateDataWranglerStudyFragment(missingResourceObservation, manifest),
    /launched study fragment requires a retained valid or explicitly invalid resource observation/u
  );
});

test("a Data Wrangler Polars capability timeout remains undetermined and release-incomplete", () => {
  const manifest = studyManifest("undetermined");
  const undeterminedEntry = manifest.schedule.find(
    (entry) => entry.kind === "warm" && entry.engine === "polars" && entry.product === "data-wrangler"
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(unsupportedFragment(manifest, undeterminedEntry, 0), manifest),
    /capability check is undetermined and cannot produce a study fragment/u
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(successFragment(manifest, undeterminedEntry, 0, 10, 0), manifest),
    /capability check is undetermined and cannot produce a study fragment/u
  );
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments: [],
    finalizedAtUtc: "2026-08-02T11:50:00.000Z"
  });
  const cell = result.cells.find((candidate) => candidate.cellId === undeterminedEntry.cellId);
  assert.equal(result.accounting.allPlannedPairsComplete, false);
  assert.equal(result.accounting.pendingTrials.length, manifest.schedule.length);
  assert.equal(cell.availability, "pending");
  assert.equal(cell.releaseComplete, false);
  assert.equal(validateDataWranglerStudyResult(result), result);
});

test("Data Wrangler Polars availability is bound to the exact CSV or Parquet fixture", () => {
  const manifest = studyManifest({ csv: "available", parquet: "undetermined" });
  const csvEntry = manifest.schedule.find(
    (entry) =>
      entry.kind === "warm" && entry.engine === "polars" && entry.format === "csv" && entry.product === "data-wrangler"
  );
  const parquetEntry = manifest.schedule.find(
    (entry) =>
      entry.kind === "warm" &&
      entry.engine === "polars" &&
      entry.format === "parquet" &&
      entry.product === "data-wrangler"
  );
  assert.equal(
    validateDataWranglerStudyFragment(successFragment(manifest, csvEntry, 0, 10, 0), manifest).outcome.status,
    "success"
  );
  assert.throws(
    () =>
      validateDataWranglerStudyFragment(unsupportedFragment(manifest, parquetEntry, parquetEntry.sequence), manifest),
    /capability check is undetermined and cannot produce a study fragment/u
  );
  assert.throws(
    () => validateDataWranglerStudyFragment(successFragment(manifest, parquetEntry, 0, 10, 0), manifest),
    /capability check is undetermined and cannot produce a study fragment/u
  );
});

test("each trial records the neutral driver and only its measured product", () => {
  const manifest = studyManifest();
  for (const product of DATA_WRANGLER_STUDY_PRODUCTS) {
    const entry = manifest.schedule.find((candidate) => candidate.kind === "warm" && candidate.product === product);
    const fragment = successFragment(manifest, entry, 0, 10, entry.sequence);
    assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);
    const ids = fragment.trialProvenance.extensionsBefore.map((extension) => extension.extensionId);
    assert.equal(ids.filter((id) => id === "openwrangler-study.notebook-comparison-driver").length, 1);
    assert.equal(
      ids.filter((id) => [manifest.candidate.extensionId, manifest.baseline.extensionId].includes(id)).length,
      1
    );
    assert.equal(ids.includes(manifest.candidate.extensionId), product === "open-wrangler");
    assert.equal(ids.includes(manifest.baseline.extensionId), product === "data-wrangler");
  }

  const dataWranglerEntry = manifest.schedule.find(
    (entry) => entry.kind === "warm" && entry.product === "data-wrangler"
  );
  const contaminated = successFragment(manifest, dataWranglerEntry, 0, 10, dataWranglerEntry.sequence);
  const openWranglerEntry = {
    extensionId: manifest.candidate.extensionId,
    version: manifest.candidate.version
  };
  contaminated.trialProvenance.extensionsBefore.push(openWranglerEntry);
  contaminated.trialProvenance.extensionsAfter.push(structuredClone(openWranglerEntry));
  assert.throws(
    () => validateDataWranglerStudyFragment(contaminated, manifest),
    /exact common and product extensions/u
  );

  const changedDriver = successFragment(manifest, dataWranglerEntry, 0, 10, dataWranglerEntry.sequence);
  changedDriver.trialProvenance.driverAfter.vsix.sha256 = digest("0");
  assert.throws(
    () => validateDataWranglerStudyFragment(changedDriver, manifest),
    /does not match the manifest-pinned neutral VSIX and journey graph/u
  );
});

test("a launched setup failure keeps editor provenance when no kernel was configured", () => {
  const manifest = studyManifest();
  const entry = manifest.schedule.find((candidate) => candidate.kind === "warm");
  const fragment = successFragment(manifest, entry, 0, 10, entry.sequence);
  fragment.outcome = {
    status: "pre-action-invalid",
    reasonClass: "setup",
    actionStarted: false,
    correctness: "not-reached",
    timeout: null,
    unsupported: null
  };
  fragment.milestones = createEmptyStudyMilestones();
  fragment.sourceLoad = {
    status: "failed",
    durationMs: null,
    includedInInlineTiming: entry.kind === "cold"
  };
  fragment.engineEvidence = null;
  fragment.uiEvidence = null;
  fragment.processProofs.configuredKernel = null;
  fragment.processProofs.openWranglerRuntime = null;
  fragment.trialProvenance.kernelProcess = null;
  assert.equal(validateDataWranglerStudyFragment(fragment, manifest), fragment);

  const inventedKernel = structuredClone(fragment);
  inventedKernel.trialProvenance.kernelProcess = {
    pid: 120,
    startTimeTicks: "12000",
    kernelIdSha256: digest("1")
  };
  assert.throws(
    () => validateDataWranglerStudyFragment(inventedKernel, manifest),
    /recorded kernel provenance requires the exact configured kernel/u
  );
});

test("type-7 summaries use the preregistered ten-sample interpolation", () => {
  const values = [10, 3, 8, 1, 9, 4, 6, 2, 7, 5];
  assert.equal(type7Quantile(values, 0.5), 5.5);
  assert.ok(Math.abs(type7Quantile(values, 0.95) - 9.55) < Number.EPSILON * 10);
  const summary = summarizeStudyMetric(values);
  assert.equal(summary.count, 10);
  assert.equal(summary.median, 5.5);
  assert.ok(Math.abs(summary.p95 - 9.55) < Number.EPSILON * 10);
  assert.throws(() => type7Quantile([], 0.95), /at least one/u);
});

test("paired regression records every difference and applies all three materiality conditions", () => {
  const pairs = [...Array(10).keys()].map((index) => ({
    pairId: `pair-${index}`,
    openWrangler: 2_500 + index,
    dataWrangler: 1_000 + index
  }));
  const regression = calculatePairedStudyRegression(pairs, { absoluteThreshold: 750 });
  assert.equal(regression.releaseComplete, true);
  assert.equal(regression.positiveDifferenceCount, 10);
  assert.equal(regression.medianDifference, 1_500);
  assert.ok(regression.medianRatio >= 1.2);
  assert.equal(regression.investigationTriggered, true);
  assert.equal(regression.pairs.length, 10);

  const sixSlower = pairs.map((pair, index) => (index < 6 ? pair : { ...pair, openWrangler: pair.dataWrangler - 1 }));
  assert.equal(calculatePairedStudyRegression(sixSlower, { absoluteThreshold: 750 }).investigationTriggered, false);
  const memory = calculatePairedStudyRegression(
    [...Array(10).keys()].map((index) => ({
      pairId: `memory-${index}`,
      openWrangler: 300 * 1024 * 1024,
      dataWrangler: 0
    })),
    { absoluteThreshold: 256 * 1024 * 1024, allowZero: true }
  );
  assert.equal(memory.medianRatio, "positive-infinity");
  assert.equal(memory.investigationTriggered, true);
});

test("PSS segments use five pre-action samples and report maximum observed sampled deltas", () => {
  const MiB = 1024 * 1024;
  const samples = [];
  for (let scheduledMs = 0; scheduledMs <= 6_000; scheduledMs += 200) {
    const pssBytes =
      scheduledMs === 1_200
        ? 130 * MiB
        : scheduledMs === 2_400
          ? 150 * MiB
          : scheduledMs === 4_000
            ? 180 * MiB
            : 100 * MiB;
    samples.push(pssSample(scheduledMs, pssBytes));
  }
  const observation = {
    protocol: "openwrangler-linux-pss-observation-v1",
    clock: pssClock(),
    ownershipTracker: pssOwnershipTracker({ editorRoot: { pid: 100, startTimeTicks: "12345" } }),
    valid: true,
    reasonClass: null,
    intervalMs: 200,
    maximumLatenessMs: 50,
    missedSamples: 0,
    terminalBoundary: pssTerminalBoundary(6_000),
    retainedOwnedIdentities: pssRetainedIdentities({ editorRoot: { pid: 100, startTimeTicks: "12345" } }),
    samples
  };
  const milestones = {
    inlineActionMs: 1_000,
    inlineReadyMs: 1_202,
    workbenchActionMs: 2_000,
    workbenchReadyMs: 2_402,
    profileActionMs: 3_000,
    firstProfileReadyMs: 3_602,
    profilesCompleteMs: 4_002,
    samplingStoppedMs: 6_002
  };
  const segments = calculateStudyPssSegments(observation, milestones);
  assert.equal(segments.inline.baselinePssBytes, 100 * MiB);
  assert.equal(segments.inline.deltaPssBytes, 30 * MiB);
  assert.equal(segments.workbench.deltaPssBytes, 50 * MiB);
  assert.equal(segments.profile.deltaPssBytes, 80 * MiB);
  assert.equal(segments.completeTrial.deltaPssBytes, 80 * MiB);
  assert.deepEqual(segments.completeTrial.processCountRange, { minimum: 1, maximum: 1 });
  assert.equal(segments.completeTrial.categories["editor-main"].deltaPssBytes, 80 * MiB);
  assert.equal(segments.completeTrial.categories["configured-kernel"].deltaPssBytes, 0);
});

test("the result schema reports incomplete accounting without manufacturing missing samples", () => {
  const manifest = studyManifest();
  const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
  const fragments = entries.map((entry, index) => successFragment(manifest, entry, 0, index === 0 ? 20 : 10));
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T12:00:00.000Z"
  });
  assert.equal(result.protocol, DATA_WRANGLER_STUDY_RESULT_PROTOCOL);
  assert.equal(result.accounting.allPlannedPairsComplete, false);
  assert.equal(result.accounting.pendingTrials.length, 94);
  assert.equal(
    result.cells.reduce((sum, cell) => sum + cell.successfulWarmPairs, 0),
    1
  );
  assert.equal(result.coldTrials.length, 0);
  const measuredCell = result.cells.find((cell) => cell.completedWarmPairs === 1);
  assert.equal(measuredCell.resourceTrials.length, 2);
  assert.equal(measuredCell.resourceTrials[0].memoryMetric, "maximum-observed-sampled-pss");
  assert.deepEqual(measuredCell.resourceTrials[0].samplingLimitations, {
    configuredIntervalMs: 200,
    processMeasurementsAreSequential: true,
    betweenSampleSpikesMayBeMissed: true
  });
  assert.deepEqual(measuredCell.resourceTrials[0].processCountRange, { minimum: 2, maximum: 2 });
  assert.deepEqual(measuredCell.resourceTrials[0].segments.completeTrial.processCountRange, {
    minimum: 2,
    maximum: 2
  });
  assert.equal(validateDataWranglerStudyResult(result), result);
  const relabeled = structuredClone(result);
  relabeled.cells.find((cell) => cell.successfulWarmPairs === 1).metrics[0].pairedRegression.investigationTriggered =
    true;
  assert.throws(() => validateDataWranglerStudyResult(relabeled), /does not match its retained calculations/u);

  const alteredPairAlgebra = structuredClone(result);
  alteredPairAlgebra.cells.find(
    (cell) => cell.successfulWarmPairs === 1
  ).metrics[0].pairedRegression.pairs[0].difference += 1;
  assert.throws(() => validateDataWranglerStudyResult(alteredPairAlgebra), /paired difference/u);

  assert.equal(validateDataWranglerStudyResultEvidence({ manifest, fragments, result }), result);
  const forgedFromResultOnly = structuredClone(result);
  const forgedMetric = forgedFromResultOnly.cells.find((cell) => cell.successfulWarmPairs === 1).metrics[0];
  forgedMetric.observations[0].openWrangler += 1;
  forgedMetric.openWrangler = summarizeStudyMetric(
    forgedMetric.observations.flatMap((observation) =>
      observation.openWrangler === null ? [] : [observation.openWrangler]
    )
  );
  forgedMetric.pairedRegression = calculatePairedStudyRegression(
    forgedMetric.observations.filter(
      (observation) => observation.openWrangler !== null && observation.dataWrangler !== null
    ),
    { absoluteThreshold: forgedMetric.pairedRegression.absoluteThreshold }
  );
  assert.equal(validateDataWranglerStudyResult(forgedFromResultOnly), forgedFromResultOnly);
  assert.throws(
    () => validateDataWranglerStudyResultEvidence({ manifest, fragments, result: forgedFromResultOnly }),
    /raw fragment evidence/u
  );
});

test("completed UI milestones from correctness, cleanup, or resource failures never enter timing or memory summaries", () => {
  for (const reasonClass of ["correctness", "cleanup", "resource-sampling"]) {
    const manifest = studyManifest();
    const entries = manifest.schedule.filter((entry) => entry.blockId === manifest.schedule[0].blockId);
    const fragments = [
      postActionFailureFragment(successFragment(manifest, entries[0], 0, 99, 0), reasonClass),
      successFragment(manifest, entries[1], 0, 10, 1)
    ];
    const result = buildDataWranglerStudyResult({
      manifest,
      fragments,
      finalizedAtUtc: "2026-08-02T12:30:00.000Z"
    });
    const cell = result.cells.find((candidate) => candidate.cellId === entries[0].cellId);
    const failedKey = entries[0].product === "open-wrangler" ? "openWrangler" : "dataWrangler";
    const succeededKey = entries[1].product === "open-wrangler" ? "openWrangler" : "dataWrangler";
    assert.equal(cell.successfulWarmPairs, 0);
    assert.equal(cell.releaseComplete, false);
    for (const metric of [...cell.metrics, ...cell.descriptiveMetrics]) {
      assert.equal(metric[failedKey], null);
      assert.equal(metric[succeededKey].count, 1);
      assert.equal(metric.observations[0][failedKey], null);
    }
    for (const metric of cell.metrics) {
      assert.equal(metric.pairedRegression.successfulPairCount, 0);
    }
    assert.equal(validateDataWranglerStudyResult(result), result);
  }
});

test("ten completed warm attempts with one failure are not release-complete", () => {
  const manifest = studyManifest();
  const warmEntries = manifest.schedule.filter((entry) => entry.kind === "warm");
  const fragments = warmEntries.map((entry, executionIndex) =>
    successFragment(manifest, entry, 0, entry.product === "open-wrangler" ? 20 : 10, executionIndex)
  );
  fragments[0] = postActionFailureFragment(fragments[0], "correctness");
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T12:45:00.000Z"
  });
  const cell = result.cells.find((candidate) => candidate.cellId === warmEntries[0].cellId);
  assert.equal(cell.completedWarmPairs, 10);
  assert.equal(cell.successfulWarmPairs, 9);
  assert.equal(cell.releaseComplete, false);
  assert.equal(cell.metrics[0].pairedRegression.successfulPairCount, 9);
  assert.equal(cell.metrics[0].pairedRegression.releaseComplete, false);
  assert.equal(cell.metrics[0].openWrangler.count + cell.metrics[0].dataWrangler.count, 19);

  const manufactured = structuredClone(result);
  const manufacturedCell = manufactured.cells.find((candidate) => candidate.cellId === cell.cellId);
  manufacturedCell.metrics[0].openWrangler.count += 1;
  assert.throws(() => validateDataWranglerStudyResult(manufactured), /raw successful observations/u);
});

test("a complete schedule finalizes ten warm pairs per cell and all descriptive cold trials", () => {
  const manifest = studyManifest();
  const fragments = manifest.schedule.map((entry) =>
    successFragment(manifest, entry, 0, entry.product === "open-wrangler" ? 20 : 10)
  );
  const result = buildDataWranglerStudyResult({
    manifest,
    fragments,
    finalizedAtUtc: "2026-08-02T13:00:00.000Z"
  });
  assert.equal(result.accounting.allPlannedPairsComplete, true);
  assert.equal(result.accounting.pendingTrials.length, 0);
  assert.equal(result.fragments.length, 96);
  assert.equal(result.coldTrials.length, 16);
  for (const cell of result.cells) {
    assert.equal(cell.successfulWarmPairs, 10);
    for (const metric of cell.metrics.slice(0, 4)) {
      assert.equal(metric.pairedRegression.releaseComplete, true);
      assert.equal(metric.pairedRegression.investigationTriggered, false);
    }
    assert.equal(cell.metrics[4].pairedRegression.releaseComplete, true);
  }
  assert.deepEqual(
    result.coldTrials.slice(0, 2).map((trial) => trial.measurements.loadAndPreviewMs),
    manifest.schedule
      .filter((entry) => entry.kind === "cold")
      .slice(0, 2)
      .map((entry) => (entry.product === "open-wrangler" ? 20 : 10))
  );

  withTemporaryDirectory((directory) => {
    const outputPath = resolve(directory, "result.json");
    assert.throws(
      () =>
        createOrLoadDataWranglerStudyFinalizationIntent({
          outputPath,
          manifest,
          fragments,
          finalizedAtUtc: result.finalizedAtUtc,
          publicationOptions: {
            faultInjector: (point) => {
              if (point === "target-linked") {
                throw new Error("injected finalization-intent link crash");
              }
            },
            tokenFactory: () => "2".repeat(32)
          }
        }),
      /injected finalization-intent link crash/u
    );
    const repeated = createOrLoadDataWranglerStudyFinalizationIntent({
      outputPath,
      manifest,
      fragments,
      finalizedAtUtc: "2026-08-02T14:00:00.000Z"
    });
    assert.equal(repeated.finalizedAtUtc, result.finalizedAtUtc);
    assert.equal(readdirSync(directory).filter((name) => name.includes(".ow-study-finalize-")).length, 1);

    assert.throws(
      () =>
        writeDataWranglerStudyJsonExclusive(outputPath, result, {
          faultInjector: (point) => {
            if (point === "target-linked") {
              throw new Error("injected result link crash");
            }
          },
          tokenFactory: () => "1".repeat(32)
        }),
      /injected result link crash/u
    );
    const recovered = writeDataWranglerStudyJsonExclusive(outputPath, result);
    assert.equal(recovered.status, "recovered");
    assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), result);

    writeFileSync(resolve(directory, `.result.json.ow-study-finalize-${"f".repeat(64)}.json`), "{}\n", { mode: 0o600 });
    assert.throws(
      () =>
        createOrLoadDataWranglerStudyFinalizationIntent({
          outputPath,
          manifest,
          fragments,
          finalizedAtUtc: "2026-08-02T15:00:00.000Z"
        }),
      /more than one digest-named intent/u
    );
  });
});

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

function studyManifest(dataWranglerPolarsAvailability = "available", ownershipTracker = pssOwnershipProvenance()) {
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
  return buildDataWranglerStudyManifest({
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
      version: ownershipTracker.pythonExecutable.version,
      executableSha256: ownershipTracker.pythonExecutable.sha256,
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
    provenance: studyProvenance(dataWranglerPolarsAvailability, editor, fixtures, ownershipTracker)
  });
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
    cleanup: { closeStatus: "succeeded", afterVerification: "matched" }
  };
}

function studyProvenance(dataWranglerPolarsAvailability, editor, fixtures, ownershipTracker) {
  const controlContext = publicUiContext("33333333-3333-4333-8333-333333333333", editor, fixtures[0]);
  const capabilityCaptureIds = ["22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"];
  const capabilities = fixtures.map((fixture, index) => {
    const availability =
      typeof dataWranglerPolarsAvailability === "string"
        ? dataWranglerPolarsAvailability
        : dataWranglerPolarsAvailability[fixture.format];
    const context = publicUiContext(capabilityCaptureIds[index], editor, fixture);
    const conclusion = availability === "available" ? "available" : "capability-timeout";
    const receipt = createDataWranglerPolarsCapabilityReceipt(
      publicUiEvidence(DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND, context, conclusion),
      context
    );
    return {
      product: "data-wrangler",
      engine: "polars",
      availability,
      method: "public-capability",
      timed: false,
      fixtureId: fixture.id,
      context,
      receiptSha256: digestStudyValue(receipt),
      receipt
    };
  });
  const controlReceipt = createNeitherProductControlReceipt(
    publicUiEvidence(NEITHER_PRODUCT_CONTROL_RECEIPT_KIND, controlContext, "neither-product-control"),
    controlContext
  );
  return {
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
      pythonExecutable: structuredClone(ownershipTracker.pythonExecutable)
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
    capabilities,
    controlProfile: {
      method: "neither-product",
      fixtureId: fixtures[0].id,
      context: controlContext,
      receiptSha256: digestStudyValue(controlReceipt),
      receipt: controlReceipt
    },
    ownershipTracker: structuredClone(ownershipTracker)
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
    output: { ready: true, busy: false, obstructed: false, owner: "host-jupyter" },
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

function successFragment(manifest, scheduleEntry, attempt, duration, executionIndex = scheduleEntry.sequence) {
  const profilesCompleteMs = 3_000 + duration * 3;
  const milestones = {
    inlineActionMs: 1_000,
    inlineReadyMs: 1_000 + duration,
    workbenchActionMs: 2_000,
    workbenchReadyMs: 2_000 + duration,
    profileActionMs: 3_000,
    firstProfileReadyMs: 3_000 + duration,
    profilesCompleteMs,
    samplingStoppedMs: pssTerminalEndElapsedMs(profilesCompleteMs + 2_000)
  };
  const processProofs = studyProcessProofs(manifest, scheduleEntry.product, executionIndex, attempt);
  const cleanupProof = studyCleanupProof(processProofs);
  const sourceCopy = studySourceCopy(manifest, scheduleEntry, executionIndex, attempt);
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: {
      status: "success",
      reasonClass: null,
      actionStarted: true,
      correctness: "passed",
      timeout: null,
      unsupported: null
    },
    milestones,
    sourceCopy,
    cacheProof: studyCacheProof(manifest, scheduleEntry, sourceCopy),
    sourceLoad: {
      status: "measured",
      durationMs: scheduleEntry.kind === "cold" ? Math.max(1, duration / 2) : 5,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: studyEngineEvidence(manifest, scheduleEntry, sourceCopy, scheduleEntry.engine),
    environmentGate: studyEnvironmentGate(manifest, "passed"),
    uiEvidence: successfulUiEvidence(manifest, scheduleEntry),
    processProofs,
    resourceObservation: studyResourceObservation(milestones.profilesCompleteMs + 2_000, processProofs),
    cleanupProof,
    trialProvenance: studyTrialProvenance(manifest, scheduleEntry, processProofs, sourceCopy)
  };
}

function postActionFailureFragment(fragment, reasonClass) {
  fragment.outcome = {
    status: "product-failure",
    reasonClass,
    actionStarted: true,
    correctness: reasonClass === "correctness" ? "failed" : "passed",
    timeout: null,
    unsupported: null
  };
  if (reasonClass === "resource-sampling") {
    fragment.resourceObservation.valid = false;
    fragment.resourceObservation.reasonClass = "resource-sampling";
    fragment.resourceObservation.missedSamples = 1;
  }
  return fragment;
}

function deadlineBoundaryFragment(manifest, scheduleEntry) {
  const fragment = successFragment(manifest, scheduleEntry, 0, 10, 0);
  fragment.milestones = {
    inlineActionMs: 1_000,
    inlineReadyMs: 46_000,
    workbenchActionMs: 47_000,
    workbenchReadyMs: 107_000,
    profileActionMs: 108_000,
    firstProfileReadyMs: 108_010,
    profilesCompleteMs: 243_000,
    samplingStoppedMs: pssTerminalEndElapsedMs(245_000)
  };
  fragment.resourceObservation = studyResourceObservation(
    fragment.milestones.profilesCompleteMs + 2_000,
    fragment.processProofs
  );
  return fragment;
}

function timeoutFragment(manifest, scheduleEntry, executionIndex) {
  const deadlineMs = DATA_WRANGLER_STUDY_DEADLINES_MS["inline-preview"];
  const processProofs = studyProcessProofs(manifest, scheduleEntry.product, executionIndex, 0);
  const sourceCopy = studySourceCopy(manifest, scheduleEntry, executionIndex, 0);
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt: 0,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: {
      status: "product-failure",
      reasonClass: "timeout",
      actionStarted: true,
      correctness: "not-reached",
      timeout: {
        journey: "inline-preview",
        deadlineMs,
        observedAtMs: 1_000 + deadlineMs,
        rightCensored: { operator: ">=", valueMs: deadlineMs }
      },
      unsupported: null
    },
    milestones: { ...createEmptyStudyMilestones(), inlineActionMs: 1_000 },
    sourceCopy,
    cacheProof: studyCacheProof(manifest, scheduleEntry, sourceCopy),
    sourceLoad: {
      status: scheduleEntry.kind === "warm" ? "measured" : "not-reached",
      durationMs: scheduleEntry.kind === "warm" ? 5 : null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: studyEngineEvidence(manifest, scheduleEntry, sourceCopy, "unverified", "not-reached"),
    environmentGate: studyEnvironmentGate(manifest, "passed"),
    uiEvidence: {
      inline: { status: "timed-out" },
      workbench: { status: "not-reached" },
      profiles: {
        status: "not-reached",
        expectedColumnCount: fixtureForEntry(manifest, scheduleEntry).columns,
        columns: []
      }
    },
    processProofs,
    resourceObservation: studyResourceObservation(1_000 + deadlineMs, processProofs),
    cleanupProof: studyCleanupProof(processProofs),
    trialProvenance: studyTrialProvenance(manifest, scheduleEntry, processProofs, sourceCopy)
  };
}

function unsupportedFragment(manifest, scheduleEntry, executionIndex) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt: 0,
      recordedAtUtc: "2026-08-02T11:00:00.000Z"
    }),
    outcome: {
      status: "unsupported",
      reasonClass: null,
      actionStarted: false,
      correctness: "not-reached",
      timeout: null,
      unsupported: { publicSurface: "unavailable", comparability: "non-comparable" }
    },
    milestones: createEmptyStudyMilestones(),
    sourceCopy: null,
    cacheProof: null,
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: null,
    environmentGate: null,
    uiEvidence: null,
    processProofs: null,
    resourceObservation: null,
    cleanupProof: null,
    trialProvenance: null
  };
}

function preActionInvalidFragment(manifest, scheduleEntry, attempt, executionIndex = scheduleEntry.sequence) {
  return {
    ...createStudyFragmentIdentity({
      manifest,
      scheduleEntry,
      executionIndex,
      attempt,
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
    sourceCopy: null,
    cacheProof: null,
    sourceLoad: {
      status: "not-reached",
      durationMs: null,
      includedInInlineTiming: scheduleEntry.kind === "cold"
    },
    engineEvidence: null,
    environmentGate: studyEnvironmentGate(manifest, "failed"),
    uiEvidence: null,
    processProofs: null,
    resourceObservation: null,
    cleanupProof: null,
    trialProvenance: null
  };
}

function studyEnvironmentGate(manifest, status) {
  const count = status === "passed" ? 1 : 30;
  return {
    protocol: "openwrangler-linux-data-wrangler-study-gate-v1",
    selectionPolicy: "accept the first complete passing window and retain every attempted window",
    thresholds: studyGateThresholds(),
    provenance: studyGateProvenance(manifest),
    maximumWaitMs: 300_000,
    waitMs: count * 10_000,
    acceptedAttempt: status === "passed" ? 1 : null,
    passed: status === "passed",
    terminalFailure: status === "passed" ? null : "deadline-no-complete-window",
    attempts: [...Array(count).keys()].map((index) => studyGateAttempt(manifest, index, status === "passed"))
  };
}

function studyGateThresholds() {
  return {
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
  };
}

function studyGateProvenance(manifest) {
  return {
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
  };
}

function studyGateAttempt(manifest, index, passed) {
  const summary = {
    cpuIds: [...manifest.provenance.cpu.affinity],
    meanNonIdleCpuPercent: passed ? 5 : 26,
    maximumOneSecondNonIdleCpuPercent: passed ? 5 : 26,
    maximumCpuSomeAvg10Percent: passed ? 0.5 : 1.1,
    maximumMemoryFullAvg10Percent: 0,
    swapPageDelta: { pagesIn: 0, pagesOut: 0 },
    thermalThrottleDeltas: [{ id: "core:2", delta: 0 }],
    acPowerMatched: true,
    governorsMatched: true,
    affinityMatched: true
  };
  return {
    attempt: index + 1,
    startedAtOffsetMs: index * 10_000,
    durationMs: 10_000,
    passed,
    failureCodes: passed ? [] : ["cpu-mean", "cpu-window", "cpu-pressure"],
    summary,
    intervals: [...Array(10).keys()].map((intervalIndex) => ({
      index: intervalIndex,
      elapsedMs: (intervalIndex + 1) * 1_000,
      durationMs: 1_000,
      nonIdleCpuPercent: summary.meanNonIdleCpuPercent,
      cpuSomeAvg10Percent: summary.maximumCpuSomeAvg10Percent,
      memoryFullAvg10Percent: summary.maximumMemoryFullAvg10Percent,
      acPowerMatched: true,
      governorsMatched: true,
      affinityMatched: true,
      available: true
    }))
  };
}

function studyEngineEvidence(manifest, scheduleEntry, sourceCopy, workbenchEngine, observedAfterTrial = "verified") {
  const fixture = fixtureForEntry(manifest, scheduleEntry);
  const receipt = {
    engine: scheduleEntry.engine,
    fixtureId: fixture.id,
    fixtureSha256: fixture.sha256,
    semanticClass: "dataframe",
    rowCount: fixture.rows,
    columnCount: fixture.columns,
    schema: structuredClone(fixture.schema),
    sentinelsBefore: structuredClone(fixture.sentinels),
    sentinelsAfter: observedAfterTrial === "verified" ? structuredClone(fixture.sentinels) : null,
    filesystemIdentityBefore: structuredClone(sourceCopy.copyReceipt.filesystemIdentity),
    filesystemIdentityAfter:
      observedAfterTrial === "verified" ? structuredClone(sourceCopy.copyReceipt.filesystemIdentity) : null,
    observedBeforeAction: true,
    observedAfterTrial
  };
  return {
    sourceEngine: scheduleEntry.engine,
    sourceVerification: {
      method: "visible-notebook-runtime",
      receiptSha256: digestStudyValue(receipt),
      receipt
    },
    workbenchEngine,
    workbenchVerification: workbenchEngine === "unverified" ? "not-observed" : "public-ui"
  };
}

function resignSourceReceipt(fragment) {
  fragment.engineEvidence.sourceVerification.receiptSha256 = digestStudyValue(
    fragment.engineEvidence.sourceVerification.receipt
  );
}

function fixtureForEntry(manifest, scheduleEntry) {
  return manifest.fixtures.find((fixture) => fixture.format === scheduleEntry.format);
}

function successfulUiEvidence(manifest, scheduleEntry, distinctSemantics = "exact") {
  const fixture = fixtureForEntry(manifest, scheduleEntry);
  return {
    inline: {
      status: "ready",
      rowCount: fixture.rows,
      columnCount: fixture.columns,
      cellCompleted: true,
      stableFrames: 2,
      preview: studyPreviewEvidence(),
      surfaceOwner: scheduleEntry.product,
      controlProfileReceiptSha256: manifest.provenance.controlProfile.receiptSha256,
      launchActionVisible: true,
      launchActionPointerUsable: true,
      unobstructed: true
    },
    workbench: {
      status: "ready",
      rowCount: fixture.rows,
      columnCount: fixture.columns,
      gridVisible: true,
      busy: false,
      stableFrames: 2,
      preview: studyPreviewEvidence(),
      newlyOpenedTarget: true,
      targetSelected: true,
      engineLabel: scheduleEntry.engine,
      unobstructed: true,
      scroll: { method: "page-down", beforeC00: 0, afterC00: 50, restoredC00: 0, settled: true }
    },
    profiles: {
      status: "complete",
      expectedColumnCount: fixture.columns,
      columns: [...Array(fixture.columns).keys()].map((index) => ({
        name: `c${String(index).padStart(2, "0")}`,
        type: "integer",
        missing: { semantics: "exact-count", value: 0 },
        minimum: index,
        maximum: fixture.rows - 1 + index,
        distinct:
          distinctSemantics === "exact"
            ? {
                semantics: "exact",
                count: fixture.rows,
                percent: 100,
                displayedPoint: null,
                displayedUnit: null,
                lowerBound: null,
                upperBound: null,
                includedInCorrectness: true,
                includedInSemanticEquivalence: true
              }
            : distinctSemantics === "approximate"
              ? {
                  semantics: "approximate",
                  count: null,
                  percent: null,
                  displayedPoint: null,
                  displayedUnit: null,
                  lowerBound: fixture.rows - 10,
                  upperBound: fixture.rows,
                  includedInCorrectness: true,
                  includedInSemanticEquivalence: true
                }
              : {
                  semantics: "approximate-unqualified",
                  count: null,
                  percent: null,
                  displayedPoint: fixture.rows - 10,
                  displayedUnit: "count",
                  lowerBound: null,
                  upperBound: null,
                  includedInCorrectness: false,
                  includedInSemanticEquivalence: false
                }
      }))
    }
  };
}

function studyPreviewEvidence() {
  return {
    headers: ["c00", "c01"],
    firstRows: [
      { rowIndex: 0, c00: 0, c01: 1 },
      { rowIndex: 1, c00: 1, c01: 2 }
    ]
  };
}

function studyCacheProof(manifest, scheduleEntry, sourceCopy) {
  const resident = scheduleEntry.kind === "warm";
  return {
    protocol: "openwrangler-data-wrangler-comparison-cache-controller-v1",
    toolchain: structuredClone(manifest.provenance.cacheToolchain),
    proof: {
      protocol: "openwrangler-source-cache-proof-study-v2",
      requestedState: resident ? "resident" : "evicted",
      fdatasyncApplied: true,
      adviceAccepted: !resident,
      verification: "linux-mincore",
      pageSizeBytes: 4_096,
      totalPages: Math.ceil(sourceCopy.copyReceipt.filesystemIdentity.sizeBytes / 4_096),
      residentPagesBefore: 4,
      residentPagesAfter: resident ? Math.ceil(sourceCopy.copyReceipt.filesystemIdentity.sizeBytes / 4_096) : 0,
      identityStable: true,
      verified: true,
      sourceFilesystemIdentityBefore: structuredClone(sourceCopy.copyReceipt.filesystemIdentity),
      sourceFilesystemIdentityAfter: structuredClone(sourceCopy.copyReceipt.filesystemIdentity),
      controller: structuredClone(manifest.provenance.cacheToolchain.controller),
      pythonExecutable: structuredClone(manifest.provenance.cacheToolchain.pythonExecutable)
    }
  };
}

function studySourceCopy(manifest, scheduleEntry, executionIndex, attempt) {
  const fixture = fixtureForEntry(manifest, scheduleEntry);
  const canonicalReceipt = {
    sha256: fixture.sha256,
    filesystemIdentity: structuredClone(fixture.filesystemIdentity)
  };
  const copyReceipt = {
    sha256: fixture.sha256,
    filesystemIdentity: {
      ...structuredClone(fixture.filesystemIdentity),
      inode: String(900_000 + executionIndex * 100 + attempt)
    }
  };
  return {
    protocol: "openwrangler-data-wrangler-comparison-source-copy-v1",
    byteIdentical: true,
    mode: "0600",
    canonicalReceipt,
    copyReceipt,
    verifiedAfterProcessTreeEmpty: true,
    cleanup: {
      protocol: "openwrangler-data-wrangler-comparison-source-copy-v1",
      removed: true,
      copyReceipt: structuredClone(copyReceipt)
    }
  };
}

function studyProcessProofs(manifest, product, executionIndex, attempt) {
  const editorPid = 100 + executionIndex * 3;
  const kernelPid = editorPid + 1;
  const editorStartTimeTicks = String(12_345 + executionIndex * 100 + attempt * 10);
  const kernelStartTimeTicks = String(54_321 + executionIndex * 100 + attempt * 10);
  return {
    editorRoot: { pid: editorPid, startTimeTicks: editorStartTimeTicks, capturedAtLaunch: true },
    configuredKernel: {
      pid: kernelPid,
      startTimeTicks: kernelStartTimeTicks,
      executableSha256: manifest.python.executableSha256,
      kernelIdSha256: digestStudyValue({ executionIndex, attempt, product }),
      observedBeforeAction: true
    },
    openWranglerRuntime: {
      status: product === "open-wrangler" ? "live-kernel-absence-proven" : "not-applicable",
      pid: null,
      startTimeTicks: null
    }
  };
}

function reuseTrialProcessIdentities(target, source) {
  const oldEditor = structuredClone(target.processProofs.editorRoot);
  const oldKernel = structuredClone(target.processProofs.configuredKernel);
  target.processProofs.editorRoot = structuredClone(source.processProofs.editorRoot);
  target.processProofs.configuredKernel = structuredClone(source.processProofs.configuredKernel);
  target.trialProvenance.editorProcess = structuredClone(source.trialProvenance.editorProcess);
  target.trialProvenance.kernelProcess = structuredClone(source.trialProvenance.kernelProcess);
  target.resourceObservation.ownershipTracker = pssOwnershipTracker(source.processProofs);

  for (const sample of target.resourceObservation.samples) {
    for (const process of sample.processes) {
      const replacement =
        process.category === "editor-main" ? source.processProofs.editorRoot : source.processProofs.configuredKernel;
      process.pid = replacement.pid;
      process.startTimeTicks = replacement.startTimeTicks;
    }
  }

  target.cleanupProof.editorRootPid = source.processProofs.editorRoot.pid;
  target.cleanupProof.editorRootStartTimeTicks = source.processProofs.editorRoot.startTimeTicks;
  target.resourceObservation.retainedOwnedIdentities = pssRetainedIdentities(source.processProofs);
  target.cleanupProof.retainedOwnedIdentities = pssRetainedIdentities(source.processProofs);
  target.cleanupProof.supervisorTerminalReceipt = studyCleanupProof(source.processProofs).supervisorTerminalReceipt;
  for (const observation of target.cleanupProof.observations) {
    for (const process of observation.processes) {
      const replacement =
        process.pid === oldEditor.pid && process.startTimeTicks === oldEditor.startTimeTicks
          ? source.processProofs.editorRoot
          : process.pid === oldKernel.pid && process.startTimeTicks === oldKernel.startTimeTicks
            ? source.processProofs.configuredKernel
            : null;
      assert.notEqual(replacement, null);
      process.pid = replacement.pid;
      process.startTimeTicks = replacement.startTimeTicks;
    }
  }
}

function studyTrialProvenance(manifest, scheduleEntry, processProofs, sourceCopy) {
  const candidate = {
    sha256: manifest.candidate.sha256,
    filesystemIdentity: structuredClone(manifest.candidate.filesystemIdentity)
  };
  const python = {
    executableSha256: manifest.python.executableSha256,
    environmentSha256: manifest.python.environmentSha256,
    kernelspecSha256: manifest.python.kernel.kernelspecSha256
  };
  const fixture = fixtureForEntry(manifest, scheduleEntry);
  const fixtureReceipt = {
    id: fixture.id,
    sha256: fixture.sha256,
    filesystemIdentity: structuredClone(fixture.filesystemIdentity)
  };
  const productExtension =
    scheduleEntry.product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  const extensions = [
    ...manifest.provenance.commonExtensions.map((extension) => ({ ...extension })),
    productExtension,
    { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }
  ];
  return {
    candidateBefore: structuredClone(candidate),
    candidateAfter: structuredClone(candidate),
    editorBefore: structuredClone(manifest.editor),
    editorAfter: structuredClone(manifest.editor),
    extensionsBefore: structuredClone(extensions),
    extensionsAfter: structuredClone(extensions),
    driverBefore: structuredClone(manifest.provenance.comparisonDriver),
    driverAfter: structuredClone(manifest.provenance.comparisonDriver),
    pythonBefore: structuredClone(python),
    pythonAfter: structuredClone(python),
    fixtureBefore: structuredClone(fixtureReceipt),
    fixtureAfter: structuredClone(fixtureReceipt),
    sourceCopyBefore: {
      protocol: sourceCopy.protocol,
      byteIdentical: sourceCopy.byteIdentical,
      mode: sourceCopy.mode,
      canonicalReceipt: structuredClone(sourceCopy.canonicalReceipt),
      copyReceipt: structuredClone(sourceCopy.copyReceipt)
    },
    sourceCopyAfter: {
      protocol: sourceCopy.protocol,
      byteIdentical: sourceCopy.byteIdentical,
      mode: sourceCopy.mode,
      canonicalReceipt: structuredClone(sourceCopy.canonicalReceipt),
      copyReceipt: structuredClone(sourceCopy.copyReceipt)
    },
    editorProcess: {
      pid: processProofs.editorRoot.pid,
      startTimeTicks: processProofs.editorRoot.startTimeTicks
    },
    kernelProcess: {
      pid: processProofs.configuredKernel.pid,
      startTimeTicks: processProofs.configuredKernel.startTimeTicks,
      kernelIdSha256: processProofs.configuredKernel.kernelIdSha256
    },
    revalidatedAfterCleanup: true
  };
}

function studyCleanupProof(processProofs) {
  const ownershipTracker = pssOwnershipTracker(processProofs);
  const terminalIdentities = pssRetainedIdentities(processProofs).map(({ pid, startTimeTicks }) => ({
    pid,
    startTimeTicks,
    disposition: "terminated"
  }));
  return {
    editorRootPid: processProofs.editorRoot.pid,
    editorRootStartTimeTicks: processProofs.editorRoot.startTimeTicks,
    startedAfterTrial: true,
    intervalMs: 200,
    deadlineMs: 10_000,
    retainedOwnedIdentities: pssRetainedIdentities(processProofs).map(({ pid, startTimeTicks }) => ({
      pid,
      startTimeTicks
    })),
    supervisorTerminalReceipt: {
      protocol: ownershipTracker.protocol,
      kind: "terminal-cleanup",
      nonce: ownershipTracker.nonce,
      supervisor: {
        pid: ownershipTracker.supervisor.pid,
        startTimeTicks: ownershipTracker.supervisor.startTimeTicks
      },
      editorRoot: {
        pid: ownershipTracker.editorRoot.pid,
        startTimeTicks: ownershipTracker.editorRoot.startTimeTicks
      },
      retainedOwnedIdentities: terminalIdentities,
      identityReuseEvents: [],
      emptyCensusProof: {
        requiredConsecutiveChecks: 3,
        checks: [0, 1, 2].map((index) => ({
          monotonicNanoseconds: (PSS_TEST_ORIGIN_NANOSECONDS + BigInt(10_000 + index) * 1_000_000n).toString(),
          ownedProcessCount: 0
        }))
      },
      supervisorExitCode: 0
    },
    observations: [
      {
        sequence: 0,
        elapsedMs: 0,
        processes: [
          { pid: processProofs.editorRoot.pid, startTimeTicks: processProofs.editorRoot.startTimeTicks },
          {
            pid: processProofs.configuredKernel.pid,
            startTimeTicks: processProofs.configuredKernel.startTimeTicks
          }
        ]
      },
      { sequence: 1, elapsedMs: 200, processes: [] },
      { sequence: 2, elapsedMs: 400, processes: [] }
    ],
    treeEmpty: true,
    status: "complete",
    failure: null
  };
}

function studyResourceObservation(targetMs, processProofs) {
  const terminalScheduledMs = pssTerminalScheduledMs(targetMs);
  const samples = [];
  for (let scheduledMs = 0; scheduledMs <= terminalScheduledMs; scheduledMs += 200) {
    samples.push(fragmentPssSample(scheduledMs, processProofs));
  }
  return {
    protocol: "openwrangler-linux-pss-observation-v1",
    clock: pssClock(),
    ownershipTracker: pssOwnershipTracker(processProofs),
    valid: true,
    reasonClass: null,
    intervalMs: 200,
    maximumLatenessMs: 50,
    missedSamples: 0,
    terminalBoundary: pssTerminalBoundary(targetMs, terminalScheduledMs),
    retainedOwnedIdentities: pssRetainedIdentities(processProofs),
    samples
  };
}

const PSS_TEST_ORIGIN_NANOSECONDS = 1_000_000_000_000n;
const PSS_TEST_SAMPLE_START_DELAY_MS = 1;
const PSS_TEST_SAMPLE_DURATION_MS = 1;
function pssClock() {
  return {
    source: "linux-process-hrtime-bigint",
    originNanoseconds: PSS_TEST_ORIGIN_NANOSECONDS.toString(),
    normalization: "elapsedMs=(endedMonotonicNanoseconds-originNanoseconds)/1000000"
  };
}

function pssMonotonicNanoseconds(elapsedMs) {
  return (PSS_TEST_ORIGIN_NANOSECONDS + BigInt(Math.ceil(elapsedMs * 1_000_000))).toString();
}

function pssTerminalScheduledMs(targetMs) {
  return Math.ceil((targetMs - PSS_TEST_SAMPLE_START_DELAY_MS) / 200) * 200;
}

function pssTerminalEndElapsedMs(targetMs) {
  return pssTerminalScheduledMs(targetMs) + PSS_TEST_SAMPLE_START_DELAY_MS + PSS_TEST_SAMPLE_DURATION_MS;
}

function pssOwnershipProvenance() {
  return {
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
  };
}

function pssOwnershipTracker(processProofs) {
  return {
    ...pssOwnershipProvenance(),
    kind: "launch",
    nonce: "d".repeat(64),
    supervisor: {
      pid: processProofs.editorRoot.pid - 1,
      startTimeTicks: String(Number(processProofs.editorRoot.startTimeTicks) - 1),
      subreaperVerified: true,
      pidfdVerified: true
    },
    editorRoot: {
      pid: processProofs.editorRoot.pid,
      startTimeTicks: processProofs.editorRoot.startTimeTicks,
      processGroupId: processProofs.editorRoot.pid,
      sessionId: processProofs.editorRoot.pid
    },
    invocationSha256: "0".repeat(64),
    payloadArgvSha256: "e".repeat(64),
    payloadEnvironmentSha256: "f".repeat(64)
  };
}

function pssRetainedIdentities(processProofs) {
  return [processProofs.editorRoot, processProofs.configuredKernel, processProofs.openWranglerRuntime]
    .filter((identity) => identity?.pid !== null && identity?.pid !== undefined)
    .map((identity) => ({
      pid: identity.pid,
      startTimeTicks: identity.startTimeTicks
    }));
}

function pssTerminalBoundary(targetMs, scheduledMs = pssTerminalScheduledMs(targetMs)) {
  const startedMs = scheduledMs + PSS_TEST_SAMPLE_START_DELAY_MS;
  const endedMs = startedMs + PSS_TEST_SAMPLE_DURATION_MS;
  return {
    targetMonotonicNanoseconds: pssMonotonicNanoseconds(targetMs),
    firstEligibleSampleScheduledMonotonicNanoseconds: pssMonotonicNanoseconds(scheduledMs),
    firstEligibleSampleStartedMonotonicNanoseconds: pssMonotonicNanoseconds(startedMs),
    firstEligibleSampleEndedMonotonicNanoseconds: pssMonotonicNanoseconds(endedMs),
    startOvershootMs: startedMs - targetMs,
    sampleLatenessMs: PSS_TEST_SAMPLE_START_DELAY_MS,
    maximumOvershootMs: 250
  };
}

function fragmentPssSample(scheduledMs, processProofs) {
  const MiB = 1024 * 1024;
  const editorPssBytes = 90 * MiB;
  const kernelPssBytes = 10 * MiB;
  const startedMs = scheduledMs + PSS_TEST_SAMPLE_START_DELAY_MS;
  const elapsedMs = startedMs + PSS_TEST_SAMPLE_DURATION_MS;
  return {
    scheduledMonotonicNanoseconds: pssMonotonicNanoseconds(scheduledMs),
    startedMonotonicNanoseconds: pssMonotonicNanoseconds(startedMs),
    endedMonotonicNanoseconds: pssMonotonicNanoseconds(elapsedMs),
    latenessMs: PSS_TEST_SAMPLE_START_DELAY_MS,
    elapsedMs,
    totalPssBytes: editorPssBytes + kernelPssBytes,
    totalRssBytes: editorPssBytes + kernelPssBytes + 2_048,
    categories: {
      "editor-main": editorPssBytes,
      "renderer-gpu": 0,
      "extension-host": 0,
      "configured-kernel": kernelPssBytes,
      "open-wrangler-runtime": 0,
      "other-owned-child": 0
    },
    processes: [
      {
        pid: processProofs.editorRoot.pid,
        startTimeTicks: processProofs.editorRoot.startTimeTicks,
        category: "editor-main",
        pssBytes: editorPssBytes,
        rssBytes: editorPssBytes + 1_024
      },
      {
        pid: processProofs.configuredKernel.pid,
        startTimeTicks: processProofs.configuredKernel.startTimeTicks,
        category: "configured-kernel",
        pssBytes: kernelPssBytes,
        rssBytes: kernelPssBytes + 1_024
      }
    ]
  };
}

function pssSample(scheduledMs, pssBytes) {
  const startedMs = scheduledMs + PSS_TEST_SAMPLE_START_DELAY_MS;
  const elapsedMs = startedMs + PSS_TEST_SAMPLE_DURATION_MS;
  return {
    scheduledMonotonicNanoseconds: pssMonotonicNanoseconds(scheduledMs),
    startedMonotonicNanoseconds: pssMonotonicNanoseconds(startedMs),
    endedMonotonicNanoseconds: pssMonotonicNanoseconds(elapsedMs),
    latenessMs: PSS_TEST_SAMPLE_START_DELAY_MS,
    elapsedMs,
    totalPssBytes: pssBytes,
    totalRssBytes: pssBytes + 1024,
    categories: {
      "editor-main": pssBytes,
      "renderer-gpu": 0,
      "extension-host": 0,
      "configured-kernel": 0,
      "open-wrangler-runtime": 0,
      "other-owned-child": 0
    },
    processes: [
      {
        pid: 100,
        startTimeTicks: "12345",
        category: "editor-main",
        pssBytes,
        rssBytes: pssBytes + 1024
      }
    ]
  };
}

async function waitForStudyBridgeState(path) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assert.fail("Timed out waiting for the real supervisor payload state.");
}

function readStudyBridgeProcIdentity(pid) {
  let text;
  try {
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error.code === "ENOENT" || error.code === "ESRCH")) {
      return null;
    }
    throw error;
  }
  const closingParenthesis = text.lastIndexOf(")");
  assert.ok(closingParenthesis > 0);
  const fields = text
    .slice(closingParenthesis + 2)
    .trim()
    .split(/\s+/u);
  assert.ok(fields.length >= 20);
  return { pid, startTimeTicks: fields[19] };
}

function terminateStudyBridgeIdentity(identity) {
  if (readStudyBridgeProcIdentity(identity.pid)?.startTimeTicks !== identity.startTimeTicks) return;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ESRCH")) throw error;
  }
}

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-study-ledger-"));
  mkdirSync(resolve(directory, "fragments"), { mode: 0o700 });
  try {
    return callback(resolve(directory, "fragments"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
