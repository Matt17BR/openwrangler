#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync
} from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertDataWranglerComparisonArmInventory,
  createDataWranglerComparisonDriverProfile,
  recoverDataWranglerComparisonDriver
} from "./data-wrangler-comparison-driver.mjs";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import { recordOnePreparedDataWranglerComparisonStudyTrial } from "./data-wrangler-comparison-live-trial.mjs";
import {
  canonicalStudyJson,
  digestStudyValue,
  readDataWranglerStudyManifestPublication,
  writeDataWranglerStudyJsonExclusive
} from "./data-wrangler-comparison-study.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  runBoundedEditorCliCommand
} from "./editor-acceptance.mjs";
import { captureLinuxDataWranglerStudyProvenance } from "./linux-data-wrangler-study-gate.mjs";
import { readBoundedJson } from "./run-installed-performance.mjs";
import { DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL } from "./data-wrangler-comparison-preparation.mjs";
import { runUnrecordedPreparedDataWranglerComparisonDiagnostic } from "./run-data-wrangler-comparison-prepared.mjs";

export const DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL =
  "openwrangler-data-wrangler-comparison-unrecorded-diagnostic-v1";

const MAXIMUM_PREPARATION_BYTES = 1024 * 1024;
const EXTENSION_LINE = /^([A-Za-z0-9][A-Za-z0-9-]{0,63}\.[A-Za-z0-9][A-Za-z0-9-]{0,127})@([^\s@]+)$/u;

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label, optional = []) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const allowed = new Set([...expected, ...optional]);
  const keys = Object.keys(value);
  if (expected.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function absolutePath(value, label) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/u.test(value)) {
    fail(`${label} must be one canonical absolute single-line path.`);
  }
  return value;
}

function validatePreparation(value) {
  exactKeys(
    value,
    [
      "protocol",
      "scheduleEntryId",
      "candidatePath",
      "sourcePath",
      "editorArtifactPath",
      "pythonExecutablePath",
      "cacheControllerPath",
      "driver",
      "profile",
      "selectedKernel",
      "editorPhaseOptions"
    ],
    "Unrecorded diagnostic preparation",
    ["samplerOptions"]
  );
  if (value.protocol !== DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL) {
    fail("Unrecorded diagnostic preparation protocol is invalid.");
  }
  if (
    typeof value.scheduleEntryId !== "string" ||
    value.scheduleEntryId.length === 0 ||
    value.scheduleEntryId.length > 128 ||
    /[\0\r\n]/u.test(value.scheduleEntryId)
  ) {
    fail("Unrecorded diagnostic schedule entry ID is invalid.");
  }
  for (const [path, label] of [
    [value.candidatePath, "Unrecorded diagnostic candidate"],
    [value.sourcePath, "Unrecorded diagnostic source"],
    [value.editorArtifactPath, "Unrecorded diagnostic editor artifact"],
    [value.pythonExecutablePath, "Unrecorded diagnostic Python"],
    [value.cacheControllerPath, "Unrecorded diagnostic cache controller"]
  ]) {
    absolutePath(path, label);
  }
  exactKeys(value.driver, ["directory", "vsixPath"], "Unrecorded diagnostic driver");
  absolutePath(value.driver.directory, "Unrecorded diagnostic driver directory");
  absolutePath(value.driver.vsixPath, "Unrecorded diagnostic driver VSIX");
  exactKeys(
    value.profile,
    ["privateRoot", "userData", "extensions", "editor", "sandboxArgs", "installLabel", "inventoryLabel"],
    "Unrecorded diagnostic profile"
  );
  for (const [path, label] of [
    [value.profile.privateRoot, "Unrecorded diagnostic profile root"],
    [value.profile.userData, "Unrecorded diagnostic user-data directory"],
    [value.profile.extensions, "Unrecorded diagnostic extension directory"]
  ]) {
    absolutePath(path, label);
  }
  if (!isRecord(value.profile.editor) || !Array.isArray(value.profile.sandboxArgs)) {
    fail("Unrecorded diagnostic editor profile is malformed.");
  }
  exactKeys(value.selectedKernel, ["name", "displayName"], "Unrecorded diagnostic selected kernel");
  if (
    typeof value.selectedKernel.name !== "string" ||
    typeof value.selectedKernel.displayName !== "string" ||
    value.selectedKernel.name.length === 0 ||
    value.selectedKernel.displayName.length === 0
  ) {
    fail("Unrecorded diagnostic selected kernel is invalid.");
  }
  if (!isRecord(value.editorPhaseOptions) || (value.samplerOptions !== undefined && !isRecord(value.samplerOptions))) {
    fail("Unrecorded diagnostic editor or sampler options are malformed.");
  }
  return value;
}

export function parseDataWranglerComparisonDiagnosticArguments(argv, cwd = process.cwd()) {
  if (!Array.isArray(argv)) fail("Unrecorded diagnostic arguments must be an array.");
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !["--manifest", "--prepared"].includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) {
      fail(
        "Usage: node scripts/run-data-wrangler-comparison-diagnostic.mjs --manifest <manifest.json> --prepared <prepared.json>"
      );
    }
    values.set(flag, resolve(cwd, value));
  }
  if (values.size !== 2 || !values.has("--manifest") || !values.has("--prepared")) {
    fail(
      "Usage: node scripts/run-data-wrangler-comparison-diagnostic.mjs --manifest <manifest.json> --prepared <prepared.json>"
    );
  }
  return Object.freeze({ manifestPath: values.get("--manifest"), preparationPath: values.get("--prepared") });
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function immutableFileSnapshot(path, label) {
  let descriptor;
  try {
    const namedBefore = lstatSync(path, { bigint: true });
    if (
      !namedBefore.isFile() ||
      namedBefore.isSymbolicLink() ||
      namedBefore.nlink !== 1n ||
      namedBefore.size <= 0n ||
      (typeof process.getuid === "function" && namedBefore.uid !== BigInt(process.getuid()))
    ) {
      fail(`${label} must be one current-user-owned, singly linked regular file.`);
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameMetadata(namedBefore, opened)) fail(`${label} changed while it opened.`);
    if (opened.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${label} is too large to identify exactly.`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    const completed = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameMetadata(opened, completed) || !sameMetadata(completed, namedAfter) || BigInt(bytes) !== opened.size) {
      fail(`${label} changed while it was read.`);
    }
    return Object.freeze({
      sha256: hash.digest("hex"),
      filesystemIdentity: Object.freeze({
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        sizeBytes: Number(opened.size),
        mtimeNs: opened.mtimeNs.toString()
      })
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sameValue(left, right) {
  return canonicalStudyJson(left) === canonicalStudyJson(right);
}

function expectedProductExtensions(manifest, product) {
  const productExtension =
    product === "open-wrangler"
      ? { extensionId: manifest.candidate.extensionId, version: manifest.candidate.version }
      : { extensionId: manifest.baseline.extensionId, version: manifest.baseline.version };
  return [...manifest.provenance.commonExtensions.map((entry) => ({ ...entry })), productExtension];
}

function assertActualInventory(manifest, product, inventory) {
  const productExtensions = expectedProductExtensions(manifest, product);
  const complete = [...productExtensions, { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }];
  assertDataWranglerComparisonArmInventory(inventory, { product, expectedExtensions: complete });
  return productExtensions;
}

/**
 * Capture the path-free before/after trial provenance required by the existing
 * fragment validator. The returned callbacks retain local paths only inside
 * the process and never place them in a fragment or CLI result.
 */
export function createDataWranglerComparisonDiagnosticProvenance({
  manifest,
  scheduleEntry,
  preparation,
  readInventory
}) {
  if (!isRecord(manifest) || !isRecord(scheduleEntry) || typeof readInventory !== "function") {
    fail("Unrecorded diagnostic provenance inputs are malformed.");
  }
  const fixture = manifest.fixtures.find((entry) => entry.format === scheduleEntry.format);
  if (fixture === undefined) fail("Unrecorded diagnostic schedule entry has no fixture.");

  const capture = async (sourceCopy, driver) => {
    const candidate = immutableFileSnapshot(preparation.candidatePath, "Unrecorded diagnostic candidate");
    const source = immutableFileSnapshot(preparation.sourcePath, "Unrecorded diagnostic fixture");
    const editor = immutableFileSnapshot(preparation.editorArtifactPath, "Unrecorded diagnostic editor artifact");
    const python = immutableFileSnapshot(preparation.pythonExecutablePath, "Unrecorded diagnostic Python");
    const inventory = await readInventory();
    const extensions = assertActualInventory(manifest, scheduleEntry.product, inventory);
    if (
      !sameValue(candidate, {
        sha256: manifest.candidate.sha256,
        filesystemIdentity: manifest.candidate.filesystemIdentity
      })
    ) {
      fail("Unrecorded diagnostic candidate does not match the manifest.");
    }
    if (!sameValue(source, { sha256: fixture.sha256, filesystemIdentity: fixture.filesystemIdentity })) {
      fail("Unrecorded diagnostic fixture does not match the manifest.");
    }
    if (editor.sha256 !== manifest.editor.sha256) {
      fail("Unrecorded diagnostic editor does not match the manifest.");
    }
    if (python.sha256 !== manifest.python.executableSha256) {
      fail("Unrecorded diagnostic Python does not match the manifest.");
    }
    if (
      !sameValue(python, {
        sha256: manifest.provenance.cacheToolchain.pythonExecutable.sha256,
        filesystemIdentity: manifest.provenance.cacheToolchain.pythonExecutable.filesystemIdentity
      })
    ) {
      fail("Unrecorded diagnostic Python does not match the manifest toolchain identity.");
    }
    if (!sameValue(driver, manifest.provenance.comparisonDriver)) {
      fail("Unrecorded diagnostic driver does not match the manifest.");
    }
    return {
      candidate,
      source,
      editor,
      python,
      extensions,
      driver: structuredClone(driver),
      sourceCopy: structuredClone(sourceCopy)
    };
  };

  return Object.freeze({
    async captureTrialProvenanceBefore(value) {
      if (!sameValue(value.manifest, manifest) || value.scheduleEntry.id !== scheduleEntry.id) {
        fail("Unrecorded diagnostic provenance capture received another trial.");
      }
      return Object.freeze({
        protocol: DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL,
        manifestSha256: digestStudyValue(manifest),
        snapshot: await capture(value.sourceCopy, value.driverBefore)
      });
    },
    async revalidateTrialProvenanceAfter(value) {
      if (
        value.provenanceBefore?.protocol !== DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL ||
        value.provenanceBefore?.manifestSha256 !== digestStudyValue(manifest) ||
        value.cleanupProof?.status !== "complete" ||
        value.cleanupProof?.treeEmpty !== true
      ) {
        fail("Unrecorded diagnostic provenance was not preceded by verified process cleanup.");
      }
      const after = await capture(value.sourceCopy, value.driverAfter);
      const before = value.provenanceBefore.snapshot;
      for (const key of ["candidate", "source", "editor", "python", "extensions", "driver", "sourceCopy"]) {
        if (!sameValue(before[key], after[key])) {
          fail(`Unrecorded diagnostic ${key} provenance changed during the trial.`);
        }
      }
      const proofs = value.rawEvidence?.processProofs;
      if (!isRecord(proofs?.editorRoot)) fail("Unrecorded diagnostic omitted its editor process proof.");
      const configuredKernel = proofs.configuredKernel;
      return Object.freeze({
        candidateBefore: structuredClone(before.candidate),
        candidateAfter: structuredClone(after.candidate),
        editorBefore: structuredClone(manifest.editor),
        editorAfter: structuredClone(manifest.editor),
        extensionsBefore: structuredClone(before.extensions),
        extensionsAfter: structuredClone(after.extensions),
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
        editorProcess: {
          pid: proofs.editorRoot.pid,
          startTimeTicks: proofs.editorRoot.startTimeTicks
        },
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

function parseExtensionInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    fail("Unrecorded diagnostic extension inventory is absent or oversized.");
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = EXTENSION_LINE.exec(line);
      if (match === null) fail("Unrecorded diagnostic extension inventory is malformed.");
      return { extensionId: match[1], version: match[2] };
    });
  if (entries.length === 0 || entries.length > 64) fail("Unrecorded diagnostic extension inventory is invalid.");
  return entries;
}

async function readProfileInventory(profile) {
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
      label: "Unrecorded Data Wrangler comparison extension inventory"
    },
    { timeoutMs: 60_000 }
  );
  return parseExtensionInventory(stdout);
}

function templateForEntry(manifest, entry) {
  const template = manifest.provenance.templates.find((candidate) => candidate.product === entry.product);
  if (template === undefined) fail("Unrecorded diagnostic manifest has no product template.");
  return entry.kind === "warm"
    ? { kind: "warmed", receiptSha256: template.warmedReceiptSha256 }
    : { kind: "configured-only", receiptSha256: template.configuredOnlyReceiptSha256 };
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

function assertSuccessfulDiagnostic(fragment) {
  if (
    fragment?.outcome?.status !== "success" ||
    fragment?.outcome?.actionStarted !== true ||
    fragment?.resourceObservation === null ||
    fragment.resourceObservation.valid !== true ||
    fragment.resourceObservation.intervalMs !== 200 ||
    fragment.resourceObservation.missedSamples !== 0 ||
    !Array.isArray(fragment?.resourceObservation?.samples) ||
    fragment.resourceObservation.samples.length < 5 ||
    fragment?.cleanupProof?.status !== "complete" ||
    fragment.cleanupProof.treeEmpty !== true ||
    fragment?.sourceCopy?.cleanup?.removed !== true ||
    fragment?.trialProvenance?.revalidatedAfterCleanup !== true
  ) {
    throw new Error("The unrecorded diagnostic did not complete public UI, PSS, provenance, and cleanup evidence.");
  }
  return fragment;
}

export async function runOneUnrecordedDataWranglerComparisonDiagnostic(
  { manifestPath, preparationPath },
  environment = process.env,
  overrides = {}
) {
  const dependencies = {
    readManifest: readDataWranglerStudyManifestPublication,
    readPreparation: (path) => readBoundedJson(path, MAXIMUM_PREPARATION_BYTES),
    recoverDriver: recoverDataWranglerComparisonDriver,
    createProfile: createDataWranglerComparisonDriverProfile,
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    captureGateProvenance: captureLinuxDataWranglerStudyProvenance,
    writeManifest: writeDataWranglerStudyJsonExclusive,
    recordTrial: recordOnePreparedDataWranglerComparisonStudyTrial,
    createProvenance: createDataWranglerComparisonDiagnosticProvenance,
    readInventory: readProfileInventory,
    mkdir: mkdirSync,
    mkdtemp: mkdtempSync,
    chmod: chmodSync,
    remove: rmSync,
    id: randomUUID,
    ...overrides
  };
  absolutePath(manifestPath, "Unrecorded diagnostic manifest");
  absolutePath(preparationPath, "Unrecorded diagnostic preparation");
  const manifest = dependencies.readManifest(manifestPath);
  const preparation = validatePreparation(dependencies.readPreparation(preparationPath));
  const scheduleEntry = manifest.schedule.find((entry) => entry.id === preparation.scheduleEntryId);
  if (scheduleEntry === undefined || manifest.schedule[0]?.id !== scheduleEntry.id) {
    fail("The unrecorded diagnostic may execute only the manifest's first schedule entry.");
  }
  const fixture = manifest.fixtures.find((entry) => entry.format === scheduleEntry.format);
  if (fixture === undefined || resolve(preparation.sourcePath) === resolve(preparation.candidatePath)) {
    fail("The unrecorded diagnostic fixture or candidate binding is invalid.");
  }

  const profileEnvironment = dependencies.createEnvironment(environment, {
    OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
    OPEN_WRANGLER_EDITOR_TEMP_ROOT: preparation.profile.privateRoot
  });
  dependencies.configureTempRoot(preparation.profile.privateRoot, profileEnvironment);
  const expectedTemplate = templateForEntry(manifest, scheduleEntry);
  const profile = dependencies.createProfile({
    product: scheduleEntry.product,
    privateRoot: preparation.profile.privateRoot,
    templateKind: expectedTemplate.kind,
    templateReceiptSha256: expectedTemplate.receiptSha256,
    editor: preparation.profile.editor,
    userData: preparation.profile.userData,
    extensions: preparation.profile.extensions,
    sandboxArgs: preparation.profile.sandboxArgs,
    environment: profileEnvironment,
    installLabel: preparation.profile.installLabel,
    inventoryLabel: preparation.profile.inventoryLabel
  });
  const driverReceipt = dependencies.recoverDriver({
    directory: preparation.driver.directory,
    vsixPath: preparation.driver.vsixPath,
    expectedDriver: manifest.provenance.comparisonDriver
  });
  const readInventory = () => dependencies.readInventory(profile);
  const provenance = dependencies.createProvenance({ manifest, scheduleEntry, preparation, readInventory });
  const expectedProvenance = dependencies.captureGateProvenance(
    { cpuIds: manifest.provenance.cpu.affinity, display: displayForGate(manifest) },
    { environment: profileEnvironment }
  );

  const scratchRoot = dependencies.mkdtemp(resolve(profile.privateRoot, ".unrecorded-comparison-"));
  dependencies.chmod(scratchRoot, 0o700);
  const fragmentsDirectory = resolve(scratchRoot, "fragments");
  const intentsDirectory = resolve(scratchRoot, "intents");
  const trialDirectory = resolve(scratchRoot, "trial");
  for (const path of [fragmentsDirectory, intentsDirectory, trialDirectory]) {
    dependencies.mkdir(path, { mode: 0o700 });
  }
  const privateManifestPath = resolve(scratchRoot, "manifest.json");
  dependencies.writeManifest(privateManifestPath, manifest);
  const sourceCopyName = `diagnostic-${dependencies.id()}.${scheduleEntry.format}`;
  if (basename(sourceCopyName) !== sourceCopyName || sourceCopyName.length > 128) {
    fail("The unrecorded diagnostic source-copy name is invalid.");
  }

  let verified = false;
  try {
    const result = await dependencies.recordTrial(
      {
        manifestPath: privateManifestPath,
        fragmentsDirectory,
        intentsDirectory,
        expectedProvenance,
        preparedTrial: {
          scheduleEntryId: scheduleEntry.id,
          sourcePath: preparation.sourcePath,
          notebookPath: resolve(trialDirectory, "study.ipynb"),
          requestPath: resolve(trialDirectory, "request.json"),
          acknowledgementPath: resolve(trialDirectory, "acknowledgement.json"),
          selectedKernel: structuredClone(preparation.selectedKernel),
          // The diagnostic always attempts the public action. Failure to find it
          // remains a failed/undetermined diagnostic, never an unsupported claim.
          publicSurfaceAvailability: "available",
          editorPhaseOptions: {
            ...structuredClone(preparation.editorPhaseOptions),
            python: preparation.pythonExecutablePath,
            editorProductVersion: manifest.editor.version,
            requiresWorkbenchCdp: true
          },
          supervisorOptions: { pythonExecutable: preparation.pythonExecutablePath },
          processEvidenceOptions: {
            pythonExecutablePath: preparation.pythonExecutablePath,
            pythonExecutableSha256: manifest.python.executableSha256
          },
          ...(preparation.samplerOptions === undefined
            ? {}
            : { samplerOptions: structuredClone(preparation.samplerOptions) }),
          sourceCopy: { privateRoot: profile.privateRoot, name: sourceCopyName },
          sourceCache: {
            pythonExecutablePath: preparation.pythonExecutablePath,
            controlScriptPath: preparation.cacheControllerPath
          },
          neutralDriver: {
            receipt: driverReceipt,
            expectedExtensions: [
              ...expectedProductExtensions(manifest, scheduleEntry.product),
              { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }
            ],
            expectedTemplate,
            profile
          }
        }
      },
      {
        captureTrialProvenanceBefore: provenance.captureTrialProvenanceBefore,
        revalidateTrialProvenanceAfter: provenance.revalidateTrialProvenanceAfter,
        gateDependencies: { environment: profileEnvironment },
        neutralDriverDependencies: { readInventory }
      }
    );
    const fragment = assertSuccessfulDiagnostic(result.output);
    const maximumObservedSampledPssBytes = Math.max(
      ...fragment.resourceObservation.samples.map((sample) => sample.totalPssBytes)
    );
    verified = true;
    return Object.freeze({
      protocol: DATA_WRANGLER_COMPARISON_DIAGNOSTIC_PROTOCOL,
      recorded: false,
      manifestSha256: digestStudyValue(manifest),
      scheduleEntryId: scheduleEntry.id,
      product: scheduleEntry.product,
      engine: scheduleEntry.engine,
      format: scheduleEntry.format,
      outcome: fragment.outcome.status,
      pssSampleCount: fragment.resourceObservation.samples.length,
      memoryMetric: "maximum-observed-sampled-pss",
      maximumObservedSampledPssBytes,
      samplingIntervalMs: fragment.resourceObservation.intervalMs,
      samplingLimitations: {
        betweenSampleSpikesMayBeMissed: true,
        processMeasurementsAreSequential: true
      },
      dataWranglerBackend: "unverified",
      cleanupVerified: true
    });
  } finally {
    if (verified) dependencies.remove(scratchRoot, { recursive: true, force: false });
  }
}

async function main() {
  const options = parseDataWranglerComparisonDiagnosticArguments(process.argv.slice(2));
  const rawPreparation = readBoundedJson(options.preparationPath, MAXIMUM_PREPARATION_BYTES);
  const result =
    rawPreparation?.protocol === DATA_WRANGLER_COMPARISON_PREPARATION_PROTOCOL
      ? await runUnrecordedPreparedDataWranglerComparisonDiagnostic(options)
      : await runOneUnrecordedDataWranglerComparisonDiagnostic(options);
  process.stdout.write(`${canonicalStudyJson(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
