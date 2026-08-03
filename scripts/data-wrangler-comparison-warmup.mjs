import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { recoverDataWranglerComparisonDriver } from "./data-wrangler-comparison-driver.mjs";
import { writeDataWranglerComparisonNotebook } from "./data-wrangler-comparison-notebook.mjs";
import {
  captureDataWranglerProfileTree,
  cloneDataWranglerCapturedTemplate
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
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase
} from "./editor-acceptance.mjs";

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
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createSourceCopy: createDataWranglerComparisonSourceCopy,
    cleanupSourceCopy: cleanupDataWranglerComparisonSourceCopy,
    writeNotebook: writeDataWranglerComparisonNotebook,
    runPhase: runEditorAcceptancePhase,
    readInventory,
    captureTree: captureDataWranglerProfileTree,
    controlWarmup: controlDataWranglerPublicWarmup,
    recoverDriver: recoverDataWranglerComparisonDriver,
    materializeKernel: materializeDataWranglerComparisonRunKernel,
    remove: rmSync,
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
    const clone = dependencies.cloneTemplate(
      { ...configured, treeSha256: configuredTree },
      { cloneRoot: resolve(studyRoot, "templates", product, `warmed-${id}`) }
    );
    const runRoot = resolve(studyRoot, "warmup-runs", `${product}-${id}`);
    mkdirSync(runRoot, { recursive: true, mode: 0o700 });
    chmodSync(runRoot, 0o700);
    const bridgeRoot = resolve(runRoot, "bridge");
    mkdirSync(bridgeRoot, { mode: 0o700 });
    chmodSync(bridgeRoot, 0o700);
    const runEnvironment = dependencies.createEnvironment(environment, {
      OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
      OPEN_WRANGLER_EDITOR_TEMP_ROOT: runRoot
    });
    dependencies.configureTempRoot(runRoot, runEnvironment);
    const runKernel = dependencies.materializeKernel({ runRoot, kernel });
    const productExtension =
      product === "open-wrangler"
        ? { extensionId: specification.candidate.extensionId, version: specification.candidate.version }
        : { extensionId: specification.baseline.extensionId, version: specification.baseline.version };
    const expectedInventory = createDataWranglerComparisonTemplateInventory(productExtension);
    assertInventory(
      await dependencies.readInventory({
        editor,
        userData: clone.userData,
        extensions: clone.extensions,
        sandboxArgs: clone.sandboxArgs,
        environment: runEnvironment
      }),
      expectedInventory
    );
    const sourceCopy = dependencies.createSourceCopy({
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
    let completed = false;
    try {
      const controlAbort = new AbortController();
      const controlPromise = Promise.resolve().then(() =>
        dependencies.controlWarmup({
          requestPath,
          acknowledgementPath,
          runId: id,
          phase: PHASES[product],
          signal: controlAbort.signal
        })
      );
      const phasePromise = Promise.resolve().then(() =>
        dependencies.runPhase(
          {
            editor,
            workspace: notebookPath,
            userData: clone.userData,
            extensions: clone.extensions,
            developmentPaths: [driverDirectory],
            python: pythonPath,
            phase: PHASES[product],
            resultPath,
            editorProductVersion: editor.version,
            runId: id,
            progressPath: editorAcceptanceProgressPath(resultPath, id, PHASES[product]),
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
      const receipt = validateWarmupReceipt(raw, {
        product,
        editor,
        fixture,
        kernel,
        sourceReceipt: sourceCopy.copyReceipt,
        controlReceipt
      });
      dependencies.cleanupSourceCopy(sourceCopy);
      dependencies.recoverDriver({ directory: driverDirectory, vsixPath: driverVsixPath, expectedDriver });
      assertInventory(
        await dependencies.readInventory({
          editor,
          userData: clone.userData,
          extensions: clone.extensions,
          sandboxArgs: clone.sandboxArgs,
          environment: runEnvironment
        }),
        expectedInventory
      );
      dependencies.remove(runRoot, { recursive: true, force: false });
      const tree = dependencies.captureTree(clone.root, `Public ${product} warmed template`);
      retainedTemplates.push(
        Object.freeze({
          product,
          kind: "warmed",
          root: clone.root,
          sandboxArgs: clone.sandboxArgs,
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
    } finally {
      if (!completed) {
        // Retain the exact profile and run journal for review; no uncertain state is reused.
      }
    }
  }
  return Object.freeze({ templates: Object.freeze(retainedTemplates), provenance: Object.freeze(provenance) });
}
