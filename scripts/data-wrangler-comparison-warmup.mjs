import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createDataWranglerComparisonCleanupUnsettledError,
  dataWranglerComparisonCleanupMayBeUnsettled
} from "./data-wrangler-comparison-cleanup-safety.mjs";
import { recoverDataWranglerComparisonDriver } from "./data-wrangler-comparison-driver.mjs";
import { writeDataWranglerComparisonNotebook } from "./data-wrangler-comparison-notebook.mjs";
import {
  captureDataWranglerComparisonOwnedDirectory,
  captureOpaqueSafeDataWranglerProfileTemplate,
  captureDataWranglerProfileTree,
  cloneDataWranglerCapturedTemplate,
  installOpaqueDataWranglerMarketplaceExtension,
  retireDataWranglerComparisonOwnedDirectory,
  retireDataWranglerComparisonTemplateClone
} from "./data-wrangler-comparison-preparation.mjs";
import { createDataWranglerComparisonTemplateInventory } from "./data-wrangler-comparison-inventory.mjs";
import { materializeDataWranglerComparisonRunKernel } from "./data-wrangler-comparison-run-kernel.mjs";
import {
  cleanupDataWranglerComparisonSourceCopy,
  createDataWranglerComparisonSourceCopy
} from "./data-wrangler-comparison-source-copy.mjs";
import { canonicalStudyJson, digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import {
  DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
  DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
  createDataWranglerStudyBridgeResponder,
  validateDataWranglerStudyBridgeAcknowledgement,
  validateDataWranglerStudyBridgeRequest
} from "./data-wrangler-study-control-bridge.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  editorAcceptanceProgressPath,
  editorProcessTreeMayBeLive,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase
} from "./editor-acceptance.mjs";
import { requireLinuxInotifyWatchHeadroom } from "./linux-inotify-watch-headroom.mjs";

export const DATA_WRANGLER_PUBLIC_WARMUP_PHASE_PROTOCOL = "openwrangler-data-wrangler-public-warmup-phase-v1";
export const DATA_WRANGLER_PUBLIC_WARMUP_CONTROL_PROTOCOL = "openwrangler-data-wrangler-public-warmup-control-v1";
export const DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS = Object.freeze([
  "source-verified",
  "measurement-ready",
  "sampling-origin",
  "inline-baseline",
  "workbench-baseline",
  "profile-baseline",
  "sampling-stop",
  "cleanup-census"
]);
const PHASES = Object.freeze({
  "open-wrangler": "comparison-study-open-wrangler-warmup",
  "data-wrangler": "comparison-study-data-wrangler-warmup"
});

function fail(message) {
  throw new TypeError(message);
}

function normalizedInventory(entries) {
  return entries.map((entry) => `${entry.extensionId.toLowerCase()}@${entry.version}`).sort();
}

function parseInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    fail("Public warm-up extension inventory is absent or oversized.");
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf("@");
      if (separator < 3 || separator === line.length - 1) fail("Public warm-up extension inventory is malformed.");
      return { extensionId: line.slice(0, separator), version: line.slice(separator + 1) };
    });
  if (entries.length === 0 || entries.length > 64) fail("Public warm-up extension inventory is invalid.");
  return entries;
}

async function readInventory({ editor, userData, extensions, sandboxArgs, environment }) {
  const { stdout } = await runBoundedEditorCliCommand(
    {
      editor,
      args: [
        "--user-data-dir",
        userData,
        "--extensions-dir",
        extensions,
        "--list-extensions",
        "--show-versions",
        ...sandboxArgs
      ],
      environment,
      label: "Official VS Code public-warm-up extension inventory"
    },
    { timeoutMs: 60_000 }
  );
  return parseInventory(stdout);
}

function assertInventory(actual, expected) {
  const observed = normalizedInventory(actual);
  const wanted = normalizedInventory(expected);
  if (observed.length !== wanted.length || observed.some((entry, index) => entry !== wanted[index])) {
    fail("Public warm-up profile does not contain its exact base dependencies and measured product.");
  }
}

function sameBridgeEnvelope(left, right) {
  return canonicalStudyJson(left) === canonicalStudyJson(right);
}

export function validateDataWranglerPublicWarmupControlReceipt(value, { runId, phase } = {}) {
  if (
    value?.protocol !== DATA_WRANGLER_PUBLIC_WARMUP_CONTROL_PROTOCOL ||
    value.runId !== runId ||
    value.phase !== phase ||
    value.requestProtocol !== DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL ||
    value.acknowledgementProtocol !== DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL ||
    !Array.isArray(value.completedExchanges) ||
    value.completedExchanges.length !== DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS.length
  ) {
    fail("Public notebook warm-up control receipt is malformed or incomplete.");
  }
  let previousAcknowledgement = 0n;
  const completedExchanges = value.completedExchanges.map((candidate, sequence) => {
    const request = validateDataWranglerStudyBridgeRequest(candidate?.request);
    const acknowledgement = validateDataWranglerStudyBridgeAcknowledgement(candidate?.acknowledgement);
    const expectedKind = DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS[sequence];
    if (
      request.runId !== runId ||
      request.phase !== phase ||
      request.sequence !== sequence ||
      request.kind !== expectedKind ||
      acknowledgement.runId !== runId ||
      acknowledgement.phase !== phase ||
      acknowledgement.sequence !== sequence ||
      acknowledgement.kind !== expectedKind
    ) {
      fail("Public notebook warm-up control exchange is stale or out of order.");
    }
    const requestTime = BigInt(request.monotonicNanoseconds);
    const acknowledgementTime = BigInt(acknowledgement.monotonicNanoseconds);
    if (requestTime < previousAcknowledgement || acknowledgementTime < requestTime) {
      fail("Public notebook warm-up control exchange clock order is invalid.");
    }
    previousAcknowledgement = acknowledgementTime;
    return Object.freeze({ request, acknowledgement });
  });
  return Object.freeze({
    protocol: value.protocol,
    runId,
    phase,
    requestProtocol: value.requestProtocol,
    acknowledgementProtocol: value.acknowledgementProtocol,
    completedExchanges: Object.freeze(completedExchanges)
  });
}

export async function controlDataWranglerPublicWarmup(
  { requestPath, acknowledgementPath, runId, phase, signal = new AbortController().signal } = {},
  { createResponder = createDataWranglerStudyBridgeResponder, responderOptions } = {}
) {
  if (typeof createResponder !== "function") fail("Public notebook warm-up control requires a responder factory.");
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function"
  ) {
    fail("Public notebook warm-up control requires an AbortSignal.");
  }
  const responder = createResponder({ requestPath, acknowledgementPath, runId, phase }, responderOptions);
  if (
    responder === null ||
    typeof responder !== "object" ||
    typeof responder.waitForRequest !== "function" ||
    typeof responder.acknowledge !== "function"
  ) {
    fail("Public notebook warm-up responder is malformed.");
  }
  const completedExchanges = [];
  for (let sequence = 0; sequence < DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS.length; sequence += 1) {
    const kind = DATA_WRANGLER_PUBLIC_WARMUP_BRIDGE_KINDS[sequence];
    const original = await responder.waitForRequest(sequence, kind, signal);
    const request = validateDataWranglerStudyBridgeRequest(original);
    const acknowledgement = validateDataWranglerStudyBridgeAcknowledgement(responder.acknowledge(original));
    completedExchanges.push(Object.freeze({ request, acknowledgement }));
  }
  return validateDataWranglerPublicWarmupControlReceipt(
    {
      protocol: DATA_WRANGLER_PUBLIC_WARMUP_CONTROL_PROTOCOL,
      runId,
      phase,
      requestProtocol: DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL,
      acknowledgementProtocol: DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL,
      completedExchanges
    },
    { runId, phase }
  );
}

function validateWarmupReceipt(raw, { product, editor, fixture, kernel, sourceReceipt, controlReceipt }) {
  if (
    raw?.protocol !== DATA_WRANGLER_PUBLIC_WARMUP_PHASE_PROTOCOL ||
    raw.product !== product ||
    raw.untimed !== true ||
    raw.locale !== "en" ||
    raw.editorVersion !== editor.version ||
    raw.study?.engine !== "polars" ||
    raw.study?.format !== fixture.format ||
    raw.study?.kind !== "warm" ||
    raw.study?.fixture?.id !== fixture.id ||
    raw.study?.fixture?.sha256 !== fixture.sha256 ||
    raw.study?.fixture?.rows !== fixture.rows ||
    raw.study?.fixture?.columns !== fixture.columns ||
    canonicalStudyJson(raw.study?.kernel) !==
      canonicalStudyJson({ name: kernel.name, displayName: kernel.displayName }) ||
    canonicalStudyJson(raw.study?.sourceReceipt) !== canonicalStudyJson(sourceReceipt) ||
    raw.study?.pythonImplementation !== "CPython" ||
    !/^3\.12(?:\.\d+)?$/u.test(raw.study?.pythonVersion) ||
    raw.profiles?.expectedColumnCount !== fixture.columns ||
    raw.profiles?.completedColumnCount !== fixture.columns ||
    raw.profiles?.canonicalOrder !== true ||
    raw.cleanup?.closeStatus !== "succeeded" ||
    raw.cleanup?.afterVerification !== "matched" ||
    raw.controlBridge?.clock !== "process-hrtime-bigint" ||
    raw.controlBridge?.authoritativeForStudy !== true ||
    raw.controlBridge?.requestProtocol !== DATA_WRANGLER_STUDY_BRIDGE_REQUEST_PROTOCOL ||
    raw.controlBridge?.acknowledgementProtocol !== DATA_WRANGLER_STUDY_BRIDGE_ACK_PROTOCOL ||
    !Array.isArray(raw.controlBridge?.exchanges) ||
    raw.controlBridge.exchanges.length !== controlReceipt.completedExchanges.length ||
    raw.controlBridge.exchanges.some(
      (exchange, index) => !sameBridgeEnvelope(exchange, controlReceipt.completedExchanges[index])
    )
  ) {
    fail("Public notebook warm-up did not complete inline preview, workbench, profiles, and cleanup exactly.");
  }
  const milestones = raw.milestones;
  const ordered = [
    milestones?.inlineActionMs,
    milestones?.inlineReadyMs,
    milestones?.workbenchActionMs,
    milestones?.workbenchReadyMs,
    milestones?.profileActionMs,
    milestones?.firstProfileReadyMs,
    milestones?.profilesCompleteMs
  ];
  if (
    ordered.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
    ordered.some((value, index) => index > 0 && value < ordered[index - 1])
  ) {
    fail("Public notebook warm-up milestone evidence is incomplete or out of order.");
  }
  return raw;
}

export async function runPreparedProductWarmupJourney(
  {
    product,
    runId,
    runRoot,
    profile,
    editor,
    pythonPath,
    kernel,
    fixture,
    fixturePath,
    driverDirectory,
    driverVsixPath,
    expectedDriver,
    expectedInventory,
    developmentPaths = [driverDirectory]
  },
  environment = process.env,
  overrides = {}
) {
  if (!Object.hasOwn(PHASES, product) || typeof runId !== "string") {
    fail("Public warm-up journey requires one measured product and run ID.");
  }
  if (
    profile === null ||
    typeof profile !== "object" ||
    !Array.isArray(profile.sandboxArgs) ||
    !Array.isArray(expectedInventory) ||
    !Array.isArray(developmentPaths)
  ) {
    fail("Public warm-up journey requires one exact profile and extension inventory.");
  }
  const dependencies = {
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createSourceCopy: createDataWranglerComparisonSourceCopy,
    cleanupSourceCopy: cleanupDataWranglerComparisonSourceCopy,
    writeNotebook: writeDataWranglerComparisonNotebook,
    runPhase: runEditorAcceptancePhase,
    requireWatchHeadroom: requireLinuxInotifyWatchHeadroom,
    readInventory,
    controlWarmup: controlDataWranglerPublicWarmup,
    recoverDriver: recoverDataWranglerComparisonDriver,
    materializeKernel: materializeDataWranglerComparisonRunKernel,
    captureRunRoot: captureDataWranglerComparisonOwnedDirectory,
    retireRunRoot: retireDataWranglerComparisonOwnedDirectory,
    ...overrides
  };
  if (lstatSync(runRoot, { bigint: true, throwIfNoEntry: false }) !== undefined) {
    fail("Public warm-up run root must be absent before setup.");
  }
  mkdirSync(dirname(runRoot), { recursive: true, mode: 0o700 });
  chmodSync(dirname(runRoot), 0o700);
  mkdirSync(runRoot, { mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const runRootReceipt = dependencies.captureRunRoot(runRoot, "Public warm-up run root");
  let sourceCopy;
  let sourceCleanupAttempted = false;
  let sourceCleanupError;
  let runRootRetirementAttempted = false;
  let operationError;
  let receipt;
  try {
    const bridgeRoot = resolve(runRoot, "bridge");
    mkdirSync(bridgeRoot, { mode: 0o700 });
    chmodSync(bridgeRoot, 0o700);
    const runEnvironment = dependencies.createEnvironment(environment, {
      OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
      OPEN_WRANGLER_EDITOR_TEMP_ROOT: runRoot
    });
    dependencies.configureTempRoot(runRoot, runEnvironment);
    const runKernel = dependencies.materializeKernel({ runRoot, kernel });
    dependencies.recoverDriver({ directory: driverDirectory, vsixPath: driverVsixPath, expectedDriver });
    assertInventory(
      await dependencies.readInventory({
        editor,
        userData: profile.userData,
        extensions: profile.extensions,
        sandboxArgs: profile.sandboxArgs,
        environment: runEnvironment
      }),
      expectedInventory
    );
    await dependencies.requireWatchHeadroom({ runRoot });
    sourceCopy = dependencies.createSourceCopy({
      canonicalPath: fixturePath,
      privateRoot: runRoot,
      name: "warmup.csv"
    });
    const notebookPath = resolve(runRoot, "warmup.ipynb");
    const requestPath = resolve(bridgeRoot, "request.json");
    const acknowledgementPath = resolve(bridgeRoot, "acknowledgement.json");
    const resultPath = resolve(runRoot, "result.json");
    dependencies.writeNotebook(notebookPath, {
      engine: "polars",
      format: "csv",
      kind: "warm",
      fixture: {
        id: fixture.id,
        format: fixture.format,
        rows: fixture.rows,
        columns: fixture.columns,
        sha256: fixture.sha256
      },
      kernel: { name: kernel.name, displayName: kernel.displayName },
      sourceReceipt: sourceCopy.copyReceipt
    });
    const controlAbort = new AbortController();
    const controlPromise = Promise.resolve().then(() =>
      dependencies.controlWarmup({
        requestPath,
        acknowledgementPath,
        runId,
        phase: PHASES[product],
        signal: controlAbort.signal
      })
    );
    const phasePromise = Promise.resolve().then(() =>
      dependencies.runPhase(
        {
          editor,
          workspace: notebookPath,
          userData: profile.userData,
          extensions: profile.extensions,
          developmentPaths,
          python: pythonPath,
          phase: PHASES[product],
          resultPath,
          editorProductVersion: editor.version,
          runId,
          progressPath: editorAcceptanceProgressPath(resultPath, runId, PHASES[product]),
          requiresWorkbenchCdp: true,
          jupyterEnvironment: structuredClone(runKernel.jupyterEnvironment),
          comparisonStudyEnvironment: {
            requestPath,
            acknowledgementPath,
            sourcePath: sourceCopy.copyPath,
            publicSurfaceAvailability: "available"
          }
        },
        { environment: runEnvironment }
      )
    );
    void phasePromise.catch((error) => controlAbort.abort(error));
    let outcomes;
    try {
      outcomes = await Promise.allSettled([phasePromise, controlPromise]);
    } finally {
      controlAbort.abort("public-warmup-settled");
    }
    const [phaseOutcome, controlOutcome] = outcomes;
    const failures = outcomes.filter((outcome) => outcome.status === "rejected").map((outcome) => outcome.reason);
    if (failures.length > 0) {
      if (
        phaseOutcome.status === "rejected" &&
        controlOutcome.status === "rejected" &&
        controlAbort.signal.reason === phaseOutcome.reason &&
        controlOutcome.reason?.code === "aborted"
      ) {
        throw phaseOutcome.reason;
      }
      if (failures.length === 1) throw failures[0];
      throw new AggregateError(failures, "Public notebook warm-up phase and its controller did not both settle.");
    }
    const [raw, controlReceipt] = outcomes.map((outcome) => outcome.value);
    receipt = validateWarmupReceipt(raw, {
      product,
      editor,
      fixture,
      kernel,
      sourceReceipt: sourceCopy.copyReceipt,
      controlReceipt
    });
    sourceCleanupAttempted = true;
    try {
      dependencies.cleanupSourceCopy(sourceCopy);
    } catch (error) {
      sourceCleanupError = error;
      throw error;
    }
    dependencies.recoverDriver({ directory: driverDirectory, vsixPath: driverVsixPath, expectedDriver });
    assertInventory(
      await dependencies.readInventory({
        editor,
        userData: profile.userData,
        extensions: profile.extensions,
        sandboxArgs: profile.sandboxArgs,
        environment: runEnvironment
      }),
      expectedInventory
    );
  } catch (error) {
    operationError = error;
  }
  const processTreeUncertain = editorProcessTreeMayBeLive(operationError);
  const cleanupErrors = [];
  if (sourceCopy !== undefined && !sourceCleanupAttempted && !processTreeUncertain) {
    sourceCleanupAttempted = true;
    try {
      dependencies.cleanupSourceCopy(sourceCopy);
    } catch (error) {
      sourceCleanupError = error;
      cleanupErrors.push(error);
    }
  }
  if (
    !runRootRetirementAttempted &&
    !processTreeUncertain &&
    !dataWranglerComparisonCleanupMayBeUnsettled(operationError) &&
    sourceCleanupError === undefined
  ) {
    runRootRetirementAttempted = true;
    try {
      const retirement = dependencies.retireRunRoot(runRootReceipt, "Public warm-up run root");
      if (retirement.status !== "retired" || retirement.treeEmpty !== true) {
        fail("Public warm-up run root was not retired.");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (sourceCleanupError !== undefined || cleanupErrors.length > 0) {
    const failures = operationError === undefined ? [...cleanupErrors] : [operationError, ...cleanupErrors];
    throw createDataWranglerComparisonCleanupUnsettledError(
      failures,
      failures.length > 1
        ? "Public warm-up and owned-path cleanup both failed."
        : "Public warm-up owned-path cleanup could not be confirmed."
    );
  }
  if (operationError !== undefined) throw operationError;
  return receipt;
}

export async function capturePreparedProductWarmups(
  {
    specification,
    templates,
    templateTrees,
    studyRoot,
    editor,
    pythonPath,
    kernel,
    fixturePath,
    driverDirectory,
    driverVsixPath
  },
  environment = process.env,
  overrides = {}
) {
  const dependencies = {
    id: randomUUID,
    cloneTemplate: cloneDataWranglerCapturedTemplate,
    captureTemplate: captureOpaqueSafeDataWranglerProfileTemplate,
    installOpaqueExtension: installOpaqueDataWranglerMarketplaceExtension,
    retireClone: retireDataWranglerComparisonTemplateClone,
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createSourceCopy: createDataWranglerComparisonSourceCopy,
    cleanupSourceCopy: cleanupDataWranglerComparisonSourceCopy,
    writeNotebook: writeDataWranglerComparisonNotebook,
    runPhase: runEditorAcceptancePhase,
    requireWatchHeadroom: requireLinuxInotifyWatchHeadroom,
    readInventory,
    captureTree: captureDataWranglerProfileTree,
    controlWarmup: controlDataWranglerPublicWarmup,
    recoverDriver: recoverDataWranglerComparisonDriver,
    materializeKernel: materializeDataWranglerComparisonRunKernel,
    ...overrides
  };
  const fixture = specification.fixtures.find((entry) => entry.format === "csv");
  if (fixture === undefined) fail("Public warm-up requires the canonical CSV fixture.");
  const expectedDriver = specification.provenance.comparisonDriver;
  dependencies.recoverDriver({ directory: driverDirectory, vsixPath: driverVsixPath, expectedDriver });
  const retainedTemplates = [];
  const provenance = [];
  for (const product of ["open-wrangler", "data-wrangler"]) {
    const configured = templates.find((entry) => entry.product === product && entry.kind === "configured-only");
    const configuredTree = templateTrees.get(`${product}:configured-only`);
    if (configured === undefined || typeof configuredTree !== "string") {
      fail(`Public warm-up has no sealed configured-only ${product} template.`);
    }
    const id = dependencies.id();
    const cloneParent = resolve(studyRoot, "warmup-clones");
    mkdirSync(cloneParent, { recursive: true, mode: 0o700 });
    chmodSync(cloneParent, 0o700);
    const clone = dependencies.cloneTemplate(
      { ...configured, treeSha256: configuredTree },
      { cloneRoot: resolve(studyRoot, "warmup-clones", `${product}-${id}`) }
    );
    let completed = false;
    let cloneRetired = false;
    let cloneRetirementAttempted = false;
    let processTreeUncertain = false;
    let cleanupUnsettled = false;
    let operationError;
    try {
      const runRoot = resolve(clone.root, "public-warmup");
      const runEnvironment = dependencies.createEnvironment(environment, {
        OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
        OPEN_WRANGLER_EDITOR_TEMP_ROOT: runRoot
      });
      const productExtension =
        product === "open-wrangler"
          ? { extensionId: specification.candidate.extensionId, version: specification.candidate.version }
          : { extensionId: specification.baseline.extensionId, version: specification.baseline.version };
      const expectedInventory = createDataWranglerComparisonTemplateInventory(productExtension);
      await dependencies.installOpaqueExtension({
        product,
        editor,
        userData: clone.userData,
        extensions: clone.extensions,
        sandboxArgs: clone.sandboxArgs,
        environment: runEnvironment,
        extension: productExtension,
        label: "Official VS Code Data Wrangler warm-up Marketplace installation"
      });
      const receipt = await runPreparedProductWarmupJourney(
        {
          product,
          runId: id,
          runRoot,
          profile: clone,
          editor,
          pythonPath,
          kernel,
          fixture,
          fixturePath,
          driverDirectory,
          driverVsixPath,
          expectedDriver,
          expectedInventory
        },
        runEnvironment,
        dependencies
      );
      const retainedRoot = resolve(studyRoot, "templates", product, `warmed-${id}`);
      const tree = dependencies.captureTemplate(
        clone.root,
        retainedRoot,
        `Public ${product} warmed template`,
        expectedInventory
      );
      cloneRetirementAttempted = true;
      const retirement = dependencies.retireClone(clone);
      if (retirement.status !== "retired" || retirement.treeEmpty !== true) {
        fail(`Public ${product} warm-up clone was not retired.`);
      }
      cloneRetired = true;
      retainedTemplates.push(
        Object.freeze({
          product,
          kind: "warmed",
          root: retainedRoot,
          sandboxArgs: clone.sandboxArgs,
          inventory: expectedInventory,
          ...tree
        })
      );
      provenance.push(
        Object.freeze({
          product,
          receiptSha256: digestStudyValue(receipt),
          receipt: structuredClone(receipt)
        })
      );
      completed = true;
    } catch (error) {
      processTreeUncertain = editorProcessTreeMayBeLive(error);
      cleanupUnsettled = dataWranglerComparisonCleanupMayBeUnsettled(error);
      operationError = error;
    }
    let cleanupError;
    if (!completed && !cloneRetired && !cloneRetirementAttempted && !processTreeUncertain && !cleanupUnsettled) {
      cloneRetirementAttempted = true;
      try {
        const retirement = dependencies.retireClone(clone);
        if (retirement.status !== "retired" || retirement.treeEmpty !== true) {
          fail(`Public ${product} warm-up clone was not retired after failure.`);
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (operationError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        `Public ${product} warm-up and clone cleanup both failed.`
      );
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
  }
  return Object.freeze({ templates: Object.freeze(retainedTemplates), provenance: Object.freeze(provenance) });
}
