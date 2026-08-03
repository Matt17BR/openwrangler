import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import {
  assertDataWranglerComparisonArmInventory,
  createDataWranglerComparisonDriverProfile,
  recoverDataWranglerComparisonDriver
} from "./data-wrangler-comparison-driver.mjs";
import { recordOnePreparedDataWranglerComparisonStudyTrial } from "./data-wrangler-comparison-live-trial.mjs";
import {
  canonicalStudyJson,
  digestStudyValue,
  loadDataWranglerStudyFragments,
  pendingDataWranglerStudyTrials,
  readDataWranglerStudyManifestPublication,
  writeDataWranglerStudyJsonExclusive
} from "./data-wrangler-comparison-study.mjs";
import {
  cloneDataWranglerComparisonTemplate,
  loadDataWranglerComparisonPreparationReceipt,
  revalidateDataWranglerComparisonPreparationReceipt,
  retireDataWranglerComparisonTemplateClone
} from "./data-wrangler-comparison-preparation.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  runBoundedEditorCliCommand
} from "./editor-acceptance.mjs";
import { captureLinuxDataWranglerStudyProvenance } from "./linux-data-wrangler-study-gate.mjs";

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

function expectedProductExtensions(manifest, product, { driver = true } = {}) {
  const measured =
    product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  return [
    ...manifest.provenance.commonExtensions.map((entry) => ({ ...entry })),
    measured,
    ...(driver ? [{ ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }] : [])
  ];
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
  revalidatePreparation
}) {
  let beforeSnapshot;
  return Object.freeze({
    async captureTrialProvenanceBefore(value) {
      await revalidatePreparation(preparation);
      const extensions = assertDataWranglerComparisonArmInventory(await readProfileInventory(profile), {
        product: entry.product,
        expectedExtensions: expectedProductExtensions(manifest, entry.product)
      });
      if (
        !sameValue(value.manifest, manifest) ||
        value.scheduleEntry.id !== entry.id ||
        !sameValue(value.driverBefore, manifest.provenance.comparisonDriver)
      ) {
        fail("Prepared comparison provenance was captured for another manifest, entry, or driver.");
      }
      beforeSnapshot = Object.freeze({
        extensions: structuredClone(extensions),
        driver: structuredClone(value.driverBefore),
        sourceCopy: structuredClone(value.sourceCopy)
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
          environmentSha256: manifest.python.environmentSha256,
          kernelspecSha256: manifest.python.kernel.kernelspecSha256
        },
        pythonAfter: {
          executableSha256: manifest.python.executableSha256,
          environmentSha256: manifest.python.environmentSha256,
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
  { manifestPath, fragmentsDirectory, intentsDirectory, preparationPath, expectedEntryId },
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
    retireClone: retireDataWranglerComparisonTemplateClone,
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createProfile: createDataWranglerComparisonDriverProfile,
    recoverDriver: recoverDataWranglerComparisonDriver,
    readInventory,
    captureGateProvenance: captureLinuxDataWranglerStudyProvenance,
    recordTrial: recordOnePreparedDataWranglerComparisonStudyTrial,
    mkdir: mkdirSync,
    id: randomUUID,
    ...overrides
  };
  const manifest = dependencies.readManifest(manifestPath);
  const fragments = dependencies.loadFragments(fragmentsDirectory, manifest);
  const entry = dependencies.pendingTrials(manifest, fragments)[0];
  if (entry === undefined) {
    return Object.freeze({ command: "run-next", status: "complete", receipt: null, output: null, cleanup: null });
  }
  if (expectedEntryId !== undefined && expectedEntryId !== entry.id) {
    fail(`Prepared comparison expected ${expectedEntryId}, but the durable ledger selected ${entry.id}.`);
  }
  const preparation = dependencies.loadPreparation(preparationPath);
  await dependencies.revalidatePreparation(preparation);
  if (preparation.manifestSha256 !== digestStudyValue(manifest) || preparation.manifestPath !== manifestPath) {
    fail("Prepared comparison receipt belongs to another manifest.");
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
  const driverReceipt = dependencies.recoverDriver({
    directory: preparation.driver.directory,
    vsixPath: preparation.driver.vsixPath,
    expectedDriver: manifest.provenance.comparisonDriver
  });
  const fixture = fixtureForEntry(manifest, entry, preparation);
  const provenance = createPreparedProvenance({
    manifest,
    entry,
    preparation,
    profile,
    readProfileInventory: dependencies.readInventory,
    revalidatePreparation: dependencies.revalidatePreparation
  });
  const expectedProvenance = dependencies.captureGateProvenance(
    { cpuIds: manifest.provenance.cpu.affinity, display: displayForGate(manifest) },
    { environment: profileEnvironment }
  );
  const trialRoot = resolve(clone.root, "trial");
  dependencies.mkdir(trialRoot, { mode: 0o700 });
  let result;
  let retired;
  let completed = false;
  try {
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
            jupyterEnvironment: structuredClone(preparation.selectedKernel.jupyterEnvironment),
            python: preparation.python.path,
            editorProductVersion: manifest.editor.version,
            requiresWorkbenchCdp: true
          },
          supervisorOptions: { pythonExecutable: preparation.python.path },
          processEvidenceOptions: {
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
            profile
          }
        }
      },
      {
        captureTrialProvenanceBefore: provenance.captureTrialProvenanceBefore,
        revalidateTrialProvenanceAfter: provenance.revalidateTrialProvenanceAfter,
        gateDependencies: { environment: profileEnvironment },
        neutralDriverDependencies: { readInventory: () => dependencies.readInventory(profile) }
      }
    );
    completed = true;
  } finally {
    if (completed) retired = dependencies.retireClone(clone);
  }
  if (retired?.status !== "retired" || retired.treeEmpty !== true) {
    fail("Prepared comparison profile clone was not retired after its measured trial.");
  }
  return Object.freeze({
    command: "run-next",
    status: result.status,
    receipt: result.receipt,
    output: result.output,
    cleanup: retired
  });
}

export async function runUnrecordedPreparedDataWranglerComparisonDiagnostic(
  { manifestPath, preparationPath },
  environment = process.env,
  overrides = {}
) {
  const manifest = readDataWranglerStudyManifestPublication(manifestPath);
  const preparation = loadDataWranglerComparisonPreparationReceipt(preparationPath);
  await revalidateDataWranglerComparisonPreparationReceipt(preparation);
  const scratchRoot = mkdtempSync(resolve(preparation.studyRoot, ".diagnostic-"));
  chmodSync(scratchRoot, 0o700);
  const fragmentsDirectory = resolve(scratchRoot, "fragments");
  const intentsDirectory = resolve(scratchRoot, "intents");
  mkdirSync(fragmentsDirectory, { mode: 0o700 });
  mkdirSync(intentsDirectory, { mode: 0o700 });
  const privateManifestPath = resolve(scratchRoot, "manifest.json");
  writeDataWranglerStudyJsonExclusive(privateManifestPath, manifest);
  const diagnosticPreparation = structuredClone(preparation);
  diagnosticPreparation.manifestPath = privateManifestPath;
  diagnosticPreparation.manifestSha256 = digestStudyValue(manifest);
  const privatePreparationPath = resolve(scratchRoot, "preparation.json");
  writeDataWranglerStudyJsonExclusive(privatePreparationPath, diagnosticPreparation);
  let result;
  let completed = false;
  try {
    result = await runPreparedDataWranglerComparisonEntry(
      {
        manifestPath: privateManifestPath,
        fragmentsDirectory,
        intentsDirectory,
        preparationPath: privatePreparationPath,
        expectedEntryId: manifest.schedule[0]?.id
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
    completed = true;
    return Object.freeze({
      protocol: DATA_WRANGLER_COMPARISON_PREPARED_RUN_PROTOCOL,
      recorded: false,
      manifestSha256: digestStudyValue(manifest),
      scheduleEntryId: manifest.schedule[0]?.id,
      outcome: result.output?.outcome?.status,
      cleanupVerified: result.cleanup?.treeEmpty === true
    });
  } finally {
    if (completed) rmSync(scratchRoot, { recursive: true, force: false });
  }
}
