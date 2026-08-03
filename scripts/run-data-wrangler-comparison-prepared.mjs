import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync } from "node:fs";
import { basename, resolve } from "node:path";
import { dataWranglerComparisonCleanupMayBeUnsettled } from "./data-wrangler-comparison-cleanup-safety.mjs";
import { createDataWranglerComparisonMeasuredInventory } from "./data-wrangler-comparison-inventory.mjs";
import {
  assertDataWranglerComparisonArmInventory,
  createDataWranglerComparisonDriverStudyReceipt,
  createDataWranglerComparisonDriverProfile,
  installDataWranglerComparisonDriver,
  recoverDataWranglerComparisonDriver
} from "./data-wrangler-comparison-driver.mjs";
import { recordOnePreparedDataWranglerComparisonStudyTrial } from "./data-wrangler-comparison-live-trial.mjs";
import { materializeDataWranglerComparisonRunKernel } from "./data-wrangler-comparison-run-kernel.mjs";
import {
  canonicalStudyJson,
  digestStudyValue,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  readDataWranglerStudyManifestPublication,
  summarizeDataWranglerStudyTrialResource,
  writeDataWranglerStudyJsonExclusive
} from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_PREPARATION_FILE_LIMITS,
  captureDataWranglerComparisonOwnedDirectory,
  captureDataWranglerPreparationFile,
  captureDataWranglerComparisonPythonEnvironment,
  cloneDataWranglerComparisonTemplate,
  installOpaqueDataWranglerMarketplaceExtension,
  loadDataWranglerComparisonPreparationReceipt,
  revalidateDataWranglerComparisonPreparationReceipt,
  revalidateDataWranglerPreparationFileIdentity,
  retireDataWranglerComparisonOwnedDirectory,
  retireDataWranglerComparisonTemplateClone,
  writeDataWranglerComparisonPreparationReceipt
} from "./data-wrangler-comparison-preparation.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  editorProcessTreeMayBeLive,
  runBoundedEditorCliCommand
} from "./editor-acceptance.mjs";
import { captureLinuxDataWranglerStudyProvenance } from "./linux-data-wrangler-study-gate.mjs";
import { runPreparedProductWarmupJourney } from "./data-wrangler-comparison-warmup.mjs";

export const DATA_WRANGLER_COMPARISON_PREPARED_RUN_PROTOCOL = "openwrangler-data-wrangler-comparison-prepared-run-v1";

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameValue(left, right) {
  return canonicalStudyJson(left) === canonicalStudyJson(right);
}

function expectedProductExtensions(manifest, product) {
  const measured =
    product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  return createDataWranglerComparisonMeasuredInventory(measured);
}

function parseInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    fail("Prepared comparison extension inventory is absent or oversized.");
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf("@");
      if (separator < 3 || separator === line.length - 1) fail("Prepared comparison extension inventory is malformed.");
      return { extensionId: line.slice(0, separator), version: line.slice(separator + 1) };
    });
  if (entries.length === 0 || entries.length > 64) fail("Prepared comparison extension inventory is invalid.");
  return entries;
}

async function readInventory(profile) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor: profile.editor,
      args: [
        "--user-data-dir",
        profile.userData,
        "--extensions-dir",
        profile.extensions,
        "--list-extensions",
        "--show-versions",
        ...profile.sandboxArgs
      ],
      environment: profile.environment,
      label: profile.inventoryLabel
    },
    { timeoutMs: 60_000 }
  );
  return parseInventory(stdout);
}

function displayForGate(manifest) {
  return {
    mode: manifest.provenance.display.mode,
    width: manifest.provenance.display.widthPx,
    height: manifest.provenance.display.heightPx,
    scaleFactor: manifest.provenance.display.deviceScaleFactor,
    zoomLevel: manifest.provenance.zoom.level,
    theme: manifest.provenance.zoom.theme
  };
}

function templateForEntry(manifest, entry) {
  const template = manifest.provenance.templates.find((candidate) => candidate.product === entry.product);
  if (template === undefined) fail("Prepared comparison manifest has no product template.");
  return entry.kind === "warm"
    ? { kind: "warmed", receiptSha256: template.warmedReceiptSha256 }
    : { kind: "configured-only", receiptSha256: template.configuredOnlyReceiptSha256 };
}

function fixtureForEntry(manifest, entry, preparation) {
  const fixture = manifest.fixtures.find((candidate) => candidate.format === entry.format);
  const prepared = preparation.fixtures.find((candidate) => candidate.format === entry.format);
  if (fixture === undefined || prepared === undefined || fixture.id !== prepared.id) {
    fail("Prepared comparison entry has no exact fixture receipt.");
  }
  return prepared;
}

function createPreparedProvenance({
  manifest,
  entry,
  preparation,
  profile,
  readProfileInventory,
  revalidatePreparation,
  prevalidatedDriver,
  prevalidatedExtensions,
  pythonBefore,
  capturePythonEnvironment,
  minimalRevalidate
}) {
  let beforeSnapshot;
  return Object.freeze({
    async captureTrialProvenanceBefore(value) {
      minimalRevalidate();
      const extensions = structuredClone(prevalidatedExtensions);
      if (
        !sameValue(value.manifest, manifest) ||
        value.scheduleEntry.id !== entry.id ||
        !sameValue(value.driverBefore, manifest.provenance.comparisonDriver)
      ) {
        fail("Prepared comparison provenance was captured for another manifest, entry, or driver.");
      }
      beforeSnapshot = Object.freeze({
        extensions: structuredClone(extensions),
        driver: structuredClone(prevalidatedDriver),
        sourceCopy: structuredClone(value.sourceCopy),
        python: structuredClone(pythonBefore)
      });
      return Object.freeze({
        protocol: DATA_WRANGLER_COMPARISON_PREPARED_RUN_PROTOCOL,
        manifestSha256: digestStudyValue(manifest),
        preparationSha256: digestStudyValue(preparation),
        snapshot: structuredClone(beforeSnapshot)
      });
    },
    async revalidateTrialProvenanceAfter(value) {
      if (
        beforeSnapshot === undefined ||
        value.provenanceBefore?.protocol !== DATA_WRANGLER_COMPARISON_PREPARED_RUN_PROTOCOL ||
        value.provenanceBefore?.manifestSha256 !== digestStudyValue(manifest) ||
        value.provenanceBefore?.preparationSha256 !== digestStudyValue(preparation) ||
        value.cleanupProof?.status !== "complete" ||
        value.cleanupProof?.treeEmpty !== true
      ) {
        fail("Prepared comparison provenance was not preceded by exact cleanup evidence.");
      }
      await revalidatePreparation(preparation);
      const extensions = assertDataWranglerComparisonArmInventory(await readProfileInventory(profile), {
        product: entry.product,
        expectedExtensions: expectedProductExtensions(manifest, entry.product)
      });
      if (
        !sameValue(extensions, beforeSnapshot.extensions) ||
        !sameValue(value.driverBefore, beforeSnapshot.driver) ||
        !sameValue(value.driverAfter, beforeSnapshot.driver) ||
        !sameValue(value.sourceCopy, beforeSnapshot.sourceCopy)
      ) {
        fail("Prepared comparison provenance changed during the measured trial.");
      }
      const fixture = manifest.fixtures.find((candidate) => candidate.format === entry.format);
      const proofs = value.rawEvidence?.processProofs;
      if (!isRecord(proofs?.editorRoot)) fail("Prepared comparison omitted its editor process proof.");
      const configuredKernel = proofs.configuredKernel;
      const pythonAfter = capturePythonEnvironment({
        pythonPath: preparation.python.path,
        kernelspecPath: preparation.selectedKernel.path,
        jupyterEnvironment: preparation.selectedKernel.jupyterEnvironment
      });
      if (
        pythonAfter.stateSha256 !== manifest.python.environmentSha256 ||
        beforeSnapshot.python.stateSha256 !== pythonAfter.stateSha256
      ) {
        fail("Prepared comparison Python packages or Jupyter state changed during the trial.");
      }
      return Object.freeze({
        candidateBefore: {
          sha256: manifest.candidate.sha256,
          filesystemIdentity: manifest.candidate.filesystemIdentity
        },
        candidateAfter: {
          sha256: manifest.candidate.sha256,
          filesystemIdentity: manifest.candidate.filesystemIdentity
        },
        editorBefore: structuredClone(manifest.editor),
        editorAfter: structuredClone(manifest.editor),
        extensionsBefore: structuredClone(extensions),
        extensionsAfter: structuredClone(extensions),
        driverBefore: structuredClone(value.driverBefore),
        driverAfter: structuredClone(value.driverAfter),
        pythonBefore: {
          executableSha256: manifest.python.executableSha256,
          environmentSha256: beforeSnapshot.python.stateSha256,
          kernelspecSha256: manifest.python.kernel.kernelspecSha256
        },
        pythonAfter: {
          executableSha256: manifest.python.executableSha256,
          environmentSha256: pythonAfter.stateSha256,
          kernelspecSha256: manifest.python.kernel.kernelspecSha256
        },
        fixtureBefore: { id: fixture.id, sha256: fixture.sha256, filesystemIdentity: fixture.filesystemIdentity },
        fixtureAfter: { id: fixture.id, sha256: fixture.sha256, filesystemIdentity: fixture.filesystemIdentity },
        sourceCopyBefore: structuredClone(value.sourceCopy),
        sourceCopyAfter: structuredClone(value.sourceCopy),
        editorProcess: { pid: proofs.editorRoot.pid, startTimeTicks: proofs.editorRoot.startTimeTicks },
        kernelProcess:
          configuredKernel === null
            ? null
            : {
                pid: configuredKernel.pid,
                startTimeTicks: configuredKernel.startTimeTicks,
                kernelIdSha256: configuredKernel.kernelIdSha256
              },
        revalidatedAfterCleanup: true
      });
    }
  });
}

function assertCloneName(value) {
  if (basename(value) !== value || !/^[a-z0-9-]{1,96}$/u.test(value))
    fail("Prepared comparison clone name is invalid.");
}

export async function runPreparedDataWranglerComparisonEntry(
  {
    manifestPath,
    fragmentsDirectory,
    intentsDirectory,
    preparationPath,
    expectedEntryId,
    retireOnlyAfterSuccessfulTrial = false
  },
  environment = process.env,
  overrides = {}
) {
  const dependencies = {
    readManifest: readDataWranglerStudyManifestPublication,
    loadFragments: loadDataWranglerStudyFragments,
    pendingTrials: pendingDataWranglerStudyTrials,
    loadPreparation: loadDataWranglerComparisonPreparationReceipt,
    revalidatePreparation: revalidateDataWranglerComparisonPreparationReceipt,
    cloneTemplate: cloneDataWranglerComparisonTemplate,
    installOpaqueExtension: installOpaqueDataWranglerMarketplaceExtension,
    retireClone: retireDataWranglerComparisonTemplateClone,
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createProfile: createDataWranglerComparisonDriverProfile,
    recoverDriver: recoverDataWranglerComparisonDriver,
    captureDriver: createDataWranglerComparisonDriverStudyReceipt,
    installDriver: installDataWranglerComparisonDriver,
    readInventory,
    captureGateProvenance: captureLinuxDataWranglerStudyProvenance,
    capturePythonEnvironment: captureDataWranglerComparisonPythonEnvironment,
    recordTrial: recordOnePreparedDataWranglerComparisonStudyTrial,
    materializeKernel: materializeDataWranglerComparisonRunKernel,
    warmProfile: runPreparedProductWarmupJourney,
    mkdir: mkdirSync,
    id: randomUUID,
    ...overrides
  };
  const preparation = dependencies.loadPreparation(preparationPath);
  await dependencies.revalidatePreparation(preparation);
  if (preparation.manifestPath !== manifestPath) {
    fail("Prepared comparison receipt belongs to another manifest path.");
  }
  const manifest = dependencies.readManifest(manifestPath);
  if (preparation.manifestSha256 !== digestStudyValue(manifest)) {
    fail("Prepared comparison receipt belongs to another manifest.");
  }
  const fragments = dependencies.loadFragments(fragmentsDirectory, manifest);
  const entry = dependencies.pendingTrials(manifest, fragments)[0];
  if (entry === undefined) {
    return Object.freeze({ command: "run-next", status: "complete", receipt: null, output: null, cleanup: null });
  }
  if (expectedEntryId !== undefined && expectedEntryId !== entry.id) {
    fail(`Prepared comparison expected ${expectedEntryId}, but the durable ledger selected ${entry.id}.`);
  }
  const expectedTemplate = templateForEntry(manifest, entry);
  const clonesParent = resolve(preparation.studyRoot, "trial-clones");
  dependencies.mkdir(clonesParent, { recursive: true, mode: 0o700 });
  const cloneName = `${entry.product === "open-wrangler" ? "ow" : "dw"}-${entry.kind}-${dependencies.id()}`;
  assertCloneName(cloneName);
  const clone = dependencies.cloneTemplate(preparation, {
    product: entry.product,
    kind: expectedTemplate.kind,
    cloneRoot: resolve(clonesParent, cloneName)
  });
  let result;
  let retired;
  let completed = false;
  let operationError;
  try {
    const profileEnvironment = dependencies.createEnvironment(environment, {
      OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
      OPEN_WRANGLER_EDITOR_TEMP_ROOT: clone.root
    });
    dependencies.configureTempRoot(clone.root, profileEnvironment);
    const editor = {
      name: "VS Code",
      key: "vscode",
      executable: preparation.editor.executablePath,
      cli: preparation.editor.cliPath,
      sharedDataDir: true,
      version: manifest.editor.version
    };
    const profile = dependencies.createProfile({
      product: entry.product,
      privateRoot: clone.root,
      templateKind: expectedTemplate.kind,
      templateReceiptSha256: expectedTemplate.receiptSha256,
      editor,
      userData: clone.userData,
      extensions: clone.extensions,
      sandboxArgs: clone.sandboxArgs,
      environment: profileEnvironment,
      installLabel: `Official VS Code ${entry.product} neutral comparison driver installation`,
      inventoryLabel: `Official VS Code ${entry.product} measured-trial extension inventory`
    });
    await dependencies.installOpaqueExtension({
      product: entry.product,
      editor,
      userData: clone.userData,
      extensions: clone.extensions,
      sandboxArgs: clone.sandboxArgs,
      environment: profileEnvironment,
      extension: manifest.baseline,
      label: "Official VS Code Data Wrangler measured-trial Marketplace installation"
    });
    const driverReceipt = dependencies.recoverDriver({
      directory: preparation.driver.directory,
      vsixPath: preparation.driver.vsixPath,
      expectedDriver: manifest.provenance.comparisonDriver
    });
    await dependencies.installDriver({ receipt: driverReceipt, profile });
    const prevalidatedDriver = dependencies.captureDriver(driverReceipt);
    if (!sameValue(prevalidatedDriver, manifest.provenance.comparisonDriver)) {
      fail("Prepared comparison installed another neutral driver than the manifest records.");
    }
    if (entry.kind === "warm") {
      const warmFixture = preparation.fixtures.find((candidate) => candidate.format === "csv");
      const warmManifestFixture = manifest.fixtures.find((candidate) => candidate.format === "csv");
      if (warmFixture === undefined || warmManifestFixture === undefined || warmFixture.id !== warmManifestFixture.id) {
        fail("Prepared comparison warm trial has no canonical CSV warm-up fixture.");
      }
      await dependencies.warmProfile(
        {
          product: entry.product,
          runId: dependencies.id(),
          runRoot: resolve(clone.root, "public-warmup"),
          profile,
          editor,
          pythonPath: preparation.python.path,
          kernel: {
            path: preparation.selectedKernel.path,
            name: preparation.selectedKernel.name,
            displayName: preparation.selectedKernel.displayName,
            sha256: manifest.python.kernel.kernelspecSha256
          },
          fixture: warmManifestFixture,
          fixturePath: warmFixture.path,
          driverDirectory: preparation.driver.directory,
          driverVsixPath: preparation.driver.vsixPath,
          expectedDriver: manifest.provenance.comparisonDriver,
          expectedInventory: expectedProductExtensions(manifest, entry.product),
          developmentPaths: []
        },
        profileEnvironment
      );
    }
    const prevalidatedExtensions = assertDataWranglerComparisonArmInventory(await dependencies.readInventory(profile), {
      product: entry.product,
      expectedExtensions: expectedProductExtensions(manifest, entry.product)
    });
    const pythonBefore = dependencies.capturePythonEnvironment({
      pythonPath: preparation.python.path,
      kernelspecPath: preparation.selectedKernel.path,
      jupyterEnvironment: preparation.selectedKernel.jupyterEnvironment
    });
    if (pythonBefore.stateSha256 !== manifest.python.environmentSha256) {
      fail("Prepared comparison Python packages or Jupyter state changed before the trial.");
    }
    const minimalRevalidate = () => {
      revalidateDataWranglerPreparationFileIdentity(preparation.candidate, "Prepared comparison candidate", {
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.candidate
      });
      revalidateDataWranglerPreparationFileIdentity(preparation.python, "Prepared comparison Python", {
        executable: true,
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.pythonExecutable
      });
      revalidateDataWranglerPreparationFileIdentity(preparation.cacheController, "Prepared cache controller", {
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.cacheController
      });
      // This is the immutable preparation fixture, not the separate-inode
      // private copy whose cache state the measured trial controls.
      const fixtureReceipt = fixtureForEntry(manifest, entry, preparation);
      revalidateDataWranglerPreparationFileIdentity(fixtureReceipt, "Prepared comparison fixture", {
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.fixture
      });
      revalidateDataWranglerPreparationFileIdentity(
        {
          path: preparation.editor.executablePath,
          sha256: preparation.editor.executableSha256,
          filesystemIdentity: preparation.editor.executableFilesystemIdentity
        },
        "Prepared comparison editor executable",
        {
          executable: true,
          maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.editorExecutable
        }
      );
      revalidateDataWranglerPreparationFileIdentity(
        {
          path: preparation.driver.vsixPath,
          sha256: manifest.provenance.comparisonDriver.vsix.sha256,
          filesystemIdentity: manifest.provenance.comparisonDriver.vsix.filesystemIdentity
        },
        "Prepared neutral-driver VSIX",
        { maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.driverVsix }
      );
      const kernelspec = captureDataWranglerPreparationFile(
        preparation.selectedKernel.path,
        "Prepared comparison kernelspec",
        { maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.kernelspec }
      );
      if (kernelspec.sha256 !== manifest.python.kernel.kernelspecSha256) {
        fail("Prepared comparison kernelspec changed before the measured spawn.");
      }
    };
    const fixture = fixtureForEntry(manifest, entry, preparation);
    const provenance = createPreparedProvenance({
      manifest,
      entry,
      preparation,
      profile,
      readProfileInventory: dependencies.readInventory,
      revalidatePreparation: dependencies.revalidatePreparation,
      prevalidatedDriver,
      prevalidatedExtensions,
      pythonBefore,
      capturePythonEnvironment: dependencies.capturePythonEnvironment,
      minimalRevalidate
    });
    const expectedProvenance = dependencies.captureGateProvenance(
      { cpuIds: manifest.provenance.cpu.affinity, display: displayForGate(manifest) },
      { environment: profileEnvironment }
    );
    const trialRoot = resolve(clone.root, "trial");
    dependencies.mkdir(trialRoot, { mode: 0o700 });
    const runKernel = dependencies.materializeKernel({
      runRoot: trialRoot,
      kernel: {
        path: preparation.selectedKernel.path,
        name: preparation.selectedKernel.name,
        displayName: preparation.selectedKernel.displayName,
        sha256: manifest.python.kernel.kernelspecSha256
      }
    });
    result = await dependencies.recordTrial(
      {
        manifestPath,
        fragmentsDirectory,
        intentsDirectory,
        expectedProvenance,
        preparedTrial: {
          scheduleEntryId: entry.id,
          sourcePath: fixture.path,
          notebookPath: resolve(trialRoot, "study.ipynb"),
          requestPath: resolve(trialRoot, "request.json"),
          acknowledgementPath: resolve(trialRoot, "acknowledgement.json"),
          selectedKernel: {
            name: preparation.selectedKernel.name,
            displayName: preparation.selectedKernel.displayName
          },
          publicSurfaceAvailability:
            entry.product === "data-wrangler" && entry.engine === "polars"
              ? manifest.provenance.capabilities.find((candidate) => candidate.fixtureId === fixture.id)?.availability
              : "available",
          editorPhaseOptions: {
            jupyterEnvironment: structuredClone(runKernel.jupyterEnvironment),
            python: preparation.python.path,
            editorProductVersion: manifest.editor.version,
            requiresWorkbenchCdp: true
          },
          supervisorOptions: { pythonExecutable: preparation.python.path },
          processEvidenceOptions: {
            editorExecutablePath: preparation.editor.executablePath,
            editorExecutableSha256: preparation.editor.executableSha256,
            pythonExecutablePath: preparation.python.path,
            pythonExecutableSha256: manifest.python.executableSha256
          },
          sourceCopy: { privateRoot: clone.root, name: `source-${dependencies.id()}.${entry.format}` },
          sourceCache: {
            pythonExecutablePath: preparation.python.path,
            controlScriptPath: preparation.cacheController.path
          },
          neutralDriver: {
            receipt: driverReceipt,
            expectedExtensions: expectedProductExtensions(manifest, entry.product),
            expectedTemplate,
            profile,
            prevalidated: {
              driver: structuredClone(prevalidatedDriver),
              installedExtensions: structuredClone(prevalidatedExtensions)
            }
          }
        }
      },
      {
        captureTrialProvenanceBefore: provenance.captureTrialProvenanceBefore,
        revalidateTrialProvenanceAfter: provenance.revalidateTrialProvenanceAfter,
        gateDependencies: { environment: profileEnvironment },
        executorDependencies: { revalidatePreparedInputsAtSpawn: minimalRevalidate },
        neutralDriverDependencies: { readInventory: () => dependencies.readInventory(profile) }
      }
    );
    completed =
      retireOnlyAfterSuccessfulTrial !== true ||
      (result.output?.outcome?.status === "success" &&
        result.output?.outcome?.actionStarted === true &&
        result.output?.cleanupProof?.status === "complete" &&
        result.output?.cleanupProof?.treeEmpty === true &&
        result.output?.sourceCopy?.cleanup?.removed === true &&
        result.output?.trialProvenance?.revalidatedAfterCleanup === true);
  } catch (error) {
    operationError = error;
  }
  // A failed unrecorded diagnostic may keep its Open Wrangler clone with the
  // private journal. Data Wrangler clones retire once process ownership is known.
  const retainFailedDiagnostic =
    retireOnlyAfterSuccessfulTrial === true && !completed && entry.product !== "data-wrangler";
  let cleanupError;
  if (
    !editorProcessTreeMayBeLive(operationError) &&
    !dataWranglerComparisonCleanupMayBeUnsettled(operationError) &&
    !retainFailedDiagnostic
  ) {
    try {
      retired = dependencies.retireClone(clone);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Prepared comparison trial and clone cleanup both failed."
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (completed && (retired?.status !== "retired" || retired.treeEmpty !== true)) {
    fail("Prepared comparison profile clone was not retired after its measured trial.");
  }
  return Object.freeze({
    command: "run-next",
    status: result.status,
    receipt: result.receipt,
    output: result.output,
    cleanup: retired ?? null
  });
}

export async function runUnrecordedPreparedDataWranglerComparisonDiagnostic(
  { manifestPath, preparationPath },
  environment = process.env,
  overrides = {}
) {
  const dependencies = {
    readManifest: readDataWranglerStudyManifestPublication,
    loadPreparation: loadDataWranglerComparisonPreparationReceipt,
    revalidatePreparation: revalidateDataWranglerComparisonPreparationReceipt,
    makeTemporaryDirectory: mkdtempSync,
    chmod: chmodSync,
    mkdir: mkdirSync,
    writeManifest: writeDataWranglerStudyJsonExclusive,
    writePreparation: writeDataWranglerComparisonPreparationReceipt,
    runEntry: runPreparedDataWranglerComparisonEntry,
    summarizeResource: summarizeDataWranglerStudyTrialResource,
    captureScratch: captureDataWranglerComparisonOwnedDirectory,
    retireScratch: retireDataWranglerComparisonOwnedDirectory,
    ...overrides
  };
  const manifest = dependencies.readManifest(manifestPath);
  const preparation = dependencies.loadPreparation(preparationPath);
  await dependencies.revalidatePreparation(preparation);
  const scratchRoot = dependencies.makeTemporaryDirectory(resolve(preparation.studyRoot, ".diagnostic-"));
  dependencies.chmod(scratchRoot, 0o700);
  const scratchReceipt = dependencies.captureScratch(scratchRoot, "Comparison diagnostic scratch");
  const fragmentsDirectory = resolve(scratchRoot, "fragments");
  const intentsDirectory = resolve(scratchRoot, "intents");
  dependencies.mkdir(fragmentsDirectory, { mode: 0o700 });
  dependencies.mkdir(intentsDirectory, { mode: 0o700 });
  const privateManifestPath = resolve(scratchRoot, "manifest.json");
  dependencies.writeManifest(privateManifestPath, manifest);
  const diagnosticPreparation = structuredClone(preparation);
  diagnosticPreparation.manifestPath = privateManifestPath;
  diagnosticPreparation.manifestSha256 = digestStudyValue(manifest);
  const privatePreparationPath = resolve(scratchRoot, "preparation.json");
  dependencies.writePreparation(privatePreparationPath, diagnosticPreparation);
  let result;
  let completed = false;
  try {
    result = await dependencies.runEntry(
      {
        manifestPath: privateManifestPath,
        fragmentsDirectory,
        intentsDirectory,
        preparationPath: privatePreparationPath,
        expectedEntryId: manifest.schedule[0]?.id,
        retireOnlyAfterSuccessfulTrial: true
      },
      environment,
      {
        ...overrides,
        revalidatePreparation: async (value) => {
          const original = { ...value, manifestPath };
          await revalidateDataWranglerComparisonPreparationReceipt(original);
          return value;
        }
      }
    );
    const fragment = result.output;
    const observation = fragment?.resourceObservation;
    const samples = Array.isArray(observation?.samples) ? observation.samples : [];
    const successful =
      fragment?.outcome?.status === "success" &&
      fragment?.outcome?.actionStarted === true &&
      observation?.valid === true &&
      observation?.intervalMs === 200 &&
      observation?.missedSamples === 0 &&
      samples.length >= 5 &&
      fragment?.cleanupProof?.status === "complete" &&
      fragment?.cleanupProof?.treeEmpty === true &&
      fragment?.sourceCopy?.cleanup?.removed === true &&
      fragment?.trialProvenance?.revalidatedAfterCleanup === true &&
      result.cleanup?.treeEmpty === true;
    const entry = manifest.schedule[0];
    const resourceSummary = Object.freeze({
      valid: observation?.valid ?? null,
      sampleCount: samples.length,
      ...dependencies.summarizeResource(fragment)
    });
    const maximumObservedSampledPssBytes =
      samples.length === 0 ? null : Math.max(...samples.map((sample) => sample.totalPssBytes));
    completed = successful;
    return Object.freeze({
      protocol: "openwrangler-data-wrangler-comparison-unrecorded-diagnostic-v1",
      recorded: false,
      manifestSha256: digestStudyValue(manifest),
      scheduleEntryId: entry?.id,
      product: entry?.product,
      engine: entry?.engine,
      format: entry?.format,
      outcome: fragment?.outcome?.status ?? "missing",
      pssSampleCount: samples.length,
      memoryMetric: "maximum-observed-sampled-pss",
      maximumObservedSampledPssBytes,
      samplingIntervalMs: observation?.intervalMs ?? null,
      samplingLimitations: {
        betweenSampleSpikesMayBeMissed: true,
        processMeasurementsAreSequential: true
      },
      resourceSummary,
      dataWranglerBackend:
        entry?.product === "data-wrangler"
          ? {
              sourceEngine: fragment?.engineEvidence?.sourceEngine ?? "unverified",
              workbenchEngine: fragment?.engineEvidence?.workbenchEngine ?? "unverified",
              workbenchVerification: fragment?.engineEvidence?.workbenchVerification ?? "not-observed"
            }
          : "not-applicable",
      cleanupVerified: successful,
      retainedFailureJournal: successful
        ? false
        : {
            retained: true,
            location: "private preparation study root",
            reason: "The diagnostic did not complete every public-UI, memory, provenance, and cleanup check."
          }
    });
  } finally {
    if (completed) dependencies.retireScratch(scratchReceipt, "Comparison diagnostic scratch");
  }
}
