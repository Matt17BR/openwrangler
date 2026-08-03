import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDataWranglerComparisonDriverProfile,
  installDataWranglerComparisonDriver,
  recoverDataWranglerComparisonDriver,
  runDataWranglerComparisonNeutralDriverPhase
} from "./data-wrangler-comparison-driver.mjs";
import { DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY } from "./data-wrangler-comparison-driver-contract.mjs";
import { writeDataWranglerComparisonNotebook } from "./data-wrangler-comparison-notebook.mjs";
import {
  cloneDataWranglerCapturedTemplate,
  retireDataWranglerComparisonTemplateClone
} from "./data-wrangler-comparison-preparation.mjs";
import {
  DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND,
  NEITHER_PRODUCT_CONTROL_RECEIPT_KIND,
  createDataWranglerPolarsCapabilityReceipt,
  createExpectedPublicUiExtensionInventory,
  createNeitherProductControlReceipt,
  createPublicUiReceiptContext
} from "./data-wrangler-public-ui-receipts.mjs";
import {
  cleanupDataWranglerComparisonSourceCopy,
  createDataWranglerComparisonSourceCopy
} from "./data-wrangler-comparison-source-copy.mjs";
import { canonicalStudyJson, digestStudyValue } from "./data-wrangler-comparison-study.mjs";
import {
  configureEditorAcceptanceTempRoot,
  createEditorAcceptanceEnvironment,
  editorAcceptanceProgressPath,
  runBoundedEditorCliCommand,
  runEditorAcceptancePhase
} from "./editor-acceptance.mjs";

export const DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL = "openwrangler-data-wrangler-public-ui-capture-phase-v1";

const PHASE = Object.freeze({
  capability: "comparison-study-data-wrangler-capability",
  control: "comparison-study-neither-product-control"
});

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  if (!isRecord(value)) fail(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function parseInventory(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 64 * 1024) {
    fail("Public-UI capture extension inventory is absent or oversized.");
  }
  const entries = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf("@");
      if (separator < 3 || separator === line.length - 1) fail("Public-UI capture extension inventory is malformed.");
      return { extensionId: line.slice(0, separator), version: line.slice(separator + 1) };
    });
  if (entries.length === 0 || entries.length > 64) fail("Public-UI capture extension inventory is invalid.");
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

function normalizedInventory(entries) {
  return entries.map((entry) => `${entry.extensionId.toLowerCase()}@${entry.version}`).sort();
}

function assertExactInventory(entries, expected, label) {
  const actual = normalizedInventory(entries);
  const wanted = normalizedInventory(expected);
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail(`${label} does not contain the exact isolated extension inventory.`);
  }
  return entries;
}

function sourceContext(captureId, editor, fixture) {
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

function expectedStudy(fixture, kernel, sourceReceipt) {
  return {
    engine: "polars",
    format: fixture.format,
    kind: "warm",
    fixture: {
      id: fixture.id,
      sha256: fixture.sha256,
      rows: fixture.rows,
      columns: fixture.columns
    },
    kernel: { name: kernel.name, displayName: kernel.displayName },
    sourceReceipt
  };
}

function validatePhaseReceipt(raw, { kind, captureId, editor, fixture, kernel, sourceReceipt }) {
  exactKeys(
    raw,
    [
      "protocol",
      "captureId",
      "kind",
      "locale",
      "editorVersion",
      "study",
      "verification",
      "observation",
      "trace",
      "output",
      "actions",
      "conclusion"
    ],
    "Public-UI capture phase receipt"
  );
  if (
    raw.protocol !== DATA_WRANGLER_PUBLIC_UI_CAPTURE_PHASE_PROTOCOL ||
    raw.captureId !== captureId ||
    raw.kind !== kind ||
    raw.locale !== editor.uiLocale ||
    raw.editorVersion !== editor.version ||
    canonicalStudyJson(raw.study) !== canonicalStudyJson(expectedStudy(fixture, kernel, sourceReceipt))
  ) {
    fail("Public-UI capture phase does not match its exact editor, source, kernel, and fixture.");
  }
  const verification = raw.verification;
  if (
    !isRecord(verification) ||
    verification.phase !== "before-timing" ||
    verification.pythonImplementation !== "CPython" ||
    verification.classMatched !== true ||
    verification.shapeMatched !== true ||
    verification.columnsMatched !== true ||
    verification.integerDtypeMatched !== true ||
    verification.sentinelsMatched !== true ||
    verification.objectTokenContinuous !== true ||
    verification.rowDataIncluded !== false ||
    verification.observedSource?.file?.sha256 !== sourceReceipt.sha256 ||
    verification.observedSource?.rowCount !== fixture.rows ||
    verification.observedSource?.columnCount !== fixture.columns
  ) {
    fail("Public-UI capture did not verify the exact warm Polars study_frame source.");
  }
  return raw;
}

function evidenceFromPhase(raw, context, kind) {
  return {
    captureId: context.captureId,
    editor: structuredClone(context.editor),
    extensions: structuredClone(
      createExpectedPublicUiExtensionInventory(
        kind === "capability" ? DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND : NEITHER_PRODUCT_CONTROL_RECEIPT_KIND
      )
    ),
    source: structuredClone(context.source),
    observation: structuredClone(raw.observation),
    trace: structuredClone(raw.trace),
    output: structuredClone(raw.output),
    actions: structuredClone(raw.actions),
    conclusion: raw.conclusion
  };
}

async function uninstallDataWrangler(profile) {
  await runBoundedEditorCliCommand(
    {
      editor: profile.editor,
      args: [
        "--user-data-dir",
        profile.userData,
        "--extensions-dir",
        profile.extensions,
        "--uninstall-extension",
        "ms-toolsai.datawrangler",
        ...profile.sandboxArgs
      ],
      environment: profile.environment,
      label: "Official VS Code neither-product control removal"
    },
    { timeoutMs: 60_000 }
  );
}

async function runCapturePhase({
  kind,
  captureId,
  clone,
  profile,
  fixture,
  fixturePath,
  kernel,
  pythonPath,
  editor,
  driver,
  expectedDriver,
  expectedExtensions,
  expectedTemplate,
  context,
  dependencies
}) {
  const trialRoot = resolve(clone.root, "public-ui");
  mkdirSync(trialRoot, { mode: 0o700 });
  const bridgeRoot = resolve(trialRoot, "bridge");
  mkdirSync(bridgeRoot, { mode: 0o700 });
  const sourceCopy = dependencies.createSourceCopy({
    canonicalPath: fixturePath,
    privateRoot: trialRoot,
    name: `source.${fixture.format}`
  });
  const notebookPath = resolve(trialRoot, "study.ipynb");
  const resultPath = resolve(trialRoot, "result.json");
  dependencies.writeNotebook(notebookPath, {
    engine: "polars",
    format: fixture.format,
    kind: "warm",
    fixture: {
      id: fixture.id,
      format: fixture.format,
      rows: fixture.rows,
      columns: fixture.columns,
      sha256: fixture.sha256
    },
    kernel: { name: kernel.name, displayName: kernel.displayName },
    sourceReceipt: structuredClone(sourceCopy.copyReceipt)
  });
  let phase;
  let operationError;
  try {
    const editorPhaseOptions = {
      workspace: notebookPath,
      python: pythonPath,
      phase: PHASE[kind],
      resultPath,
      editorProductVersion: editor.version,
      requiresWorkbenchCdp: true,
      jupyterEnvironment: structuredClone(kernel.jupyterEnvironment),
      comparisonStudyEnvironment: {
        requestPath: resolve(bridgeRoot, "request.json"),
        acknowledgementPath: resolve(bridgeRoot, "acknowledgement.json"),
        sourcePath: sourceCopy.copyPath,
        publicSurfaceAvailability: "available"
      },
      runId: captureId,
      progressPath: editorAcceptanceProgressPath(resultPath, captureId, PHASE[kind])
    };
    if (kind === "capability") {
      phase = await dependencies.runNeutralPhase(
        {
          product: "data-wrangler",
          receipt: driver,
          expectedDriver,
          expectedExtensions,
          expectedTemplate,
          profile,
          editorPhaseOptions
        },
        {
          readInventory: () => dependencies.readInventory(profile),
          runPhase: (options, runDependencies) =>
            dependencies.runEditorPhase(options, { environment: profile.environment, ...runDependencies })
        }
      );
      assertExactInventory(phase.installedExtensions, expectedExtensions, "Data Wrangler capability capture");
      phase = phase.phaseResult;
    } else {
      await dependencies.uninstallDataWrangler(profile);
      const controlExtensions = createExpectedPublicUiExtensionInventory(NEITHER_PRODUCT_CONTROL_RECEIPT_KIND).entries;
      const withoutDriver = controlExtensions.filter(
        (entry) => entry.extensionId.toLowerCase() !== DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY.extensionId
      );
      assertExactInventory(
        await dependencies.readInventory(profile),
        withoutDriver,
        "Neither-product control before driver"
      );
      await dependencies.installDriver({ receipt: driver, profile });
      assertExactInventory(
        await dependencies.readInventory(profile),
        controlExtensions,
        "Neither-product control before capture"
      );
      phase = await dependencies.runEditorPhase(
        {
          ...editorPhaseOptions,
          editor: profile.editor,
          userData: profile.userData,
          extensions: profile.extensions,
          developmentPaths: []
        },
        { environment: profile.environment }
      );
      assertExactInventory(
        await dependencies.readInventory(profile),
        controlExtensions,
        "Neither-product control after capture"
      );
    }
    phase = validatePhaseReceipt(phase, {
      kind,
      captureId,
      editor: context.editor,
      fixture,
      kernel,
      sourceReceipt: sourceCopy.copyReceipt
    });
  } catch (error) {
    operationError = error;
  }
  let cleanupError;
  try {
    dependencies.cleanupSourceCopy(sourceCopy);
  } catch (error) {
    cleanupError = error;
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([operationError, cleanupError], "Public-UI capture and source-copy cleanup both failed.");
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return phase;
}

export async function capturePreparedDataWranglerPublicUi(
  {
    specification,
    templates,
    templateTrees,
    studyRoot,
    editor,
    pythonPath,
    kernel,
    fixturePaths,
    driverDirectory,
    driverVsixPath
  },
  environment = process.env,
  overrides = {}
) {
  const dependencies = {
    cloneTemplate: cloneDataWranglerCapturedTemplate,
    retireClone: retireDataWranglerComparisonTemplateClone,
    createEnvironment: createEditorAcceptanceEnvironment,
    configureTempRoot: configureEditorAcceptanceTempRoot,
    createProfile: createDataWranglerComparisonDriverProfile,
    recoverDriver: recoverDataWranglerComparisonDriver,
    createSourceCopy: createDataWranglerComparisonSourceCopy,
    cleanupSourceCopy: cleanupDataWranglerComparisonSourceCopy,
    writeNotebook: writeDataWranglerComparisonNotebook,
    runNeutralPhase: runDataWranglerComparisonNeutralDriverPhase,
    installDriver: installDataWranglerComparisonDriver,
    runEditorPhase: runEditorAcceptancePhase,
    readInventory,
    uninstallDataWrangler,
    id: randomUUID,
    ...overrides
  };
  const baseTemplate = templates.find((entry) => entry.product === "data-wrangler" && entry.kind === "configured-only");
  const templateTreeSha256 = templateTrees.get("data-wrangler:configured-only");
  if (baseTemplate === undefined || typeof templateTreeSha256 !== "string") {
    fail("Public-UI capture requires the exact configured Data Wrangler template.");
  }
  const template = {
    ...baseTemplate,
    userData: resolve(baseTemplate.root, "user"),
    extensions: resolve(baseTemplate.root, "extensions"),
    treeSha256: templateTreeSha256
  };
  const expectedTemplate = { kind: "configured-only", receiptSha256: templateTreeSha256 };
  const driver = dependencies.recoverDriver({
    directory: driverDirectory,
    vsixPath: driverVsixPath,
    expectedDriver: specification.provenance.comparisonDriver
  });
  const publicEditor = structuredClone(specification.editor);
  if (
    specification.fixtures.length !== 2 ||
    new Set(specification.fixtures.map((fixture) => fixture.format)).size !== 2 ||
    !specification.fixtures.some((fixture) => fixture.format === "csv") ||
    !specification.fixtures.some((fixture) => fixture.format === "parquet")
  ) {
    fail("Public-UI capture requires exactly the reviewed CSV and Parquet fixtures.");
  }
  const capturePlans = [
    ...specification.fixtures.map((fixture) => ({ kind: "capability", fixture })),
    { kind: "control", fixture: specification.fixtures.find((fixture) => fixture.format === "csv") }
  ];
  const capabilities = [];
  let controlProfile;
  const bindings = [];
  const clonesParent = resolve(studyRoot, "public-ui-captures");
  mkdirSync(clonesParent, { recursive: true, mode: 0o700 });
  chmodSync(clonesParent, 0o700);
  for (const plan of capturePlans) {
    if (plan.fixture === undefined) fail("Public-UI capture has no CSV control fixture.");
    const captureId = dependencies.id();
    const clone = dependencies.cloneTemplate(template, {
      cloneRoot: resolve(clonesParent, `${plan.kind}-${plan.fixture.format}-${captureId}`)
    });
    const profileEnvironment = dependencies.createEnvironment(environment, {
      OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
      OPEN_WRANGLER_EDITOR_TEMP_ROOT: clone.root
    });
    dependencies.configureTempRoot(clone.root, profileEnvironment);
    const profile = dependencies.createProfile({
      product: "data-wrangler",
      privateRoot: clone.root,
      templateKind: "configured-only",
      templateReceiptSha256: templateTreeSha256,
      editor,
      userData: clone.userData,
      extensions: clone.extensions,
      sandboxArgs: clone.sandboxArgs,
      environment: profileEnvironment,
      installLabel: `Official VS Code ${plan.kind} public-UI driver installation`,
      inventoryLabel: `Official VS Code ${plan.kind} public-UI extension inventory`
    });
    const context = sourceContext(captureId, publicEditor, plan.fixture);
    const expectedExtensions = [
      ...specification.provenance.commonExtensions.map((entry) => ({ ...entry })),
      { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
      { ...DATA_WRANGLER_COMPARISON_DRIVER_INVENTORY_ENTRY }
    ];
    assertExactInventory(
      expectedExtensions,
      createExpectedPublicUiExtensionInventory(DATA_WRANGLER_POLARS_CAPABILITY_RECEIPT_KIND).entries,
      "Reviewed Data Wrangler capability inventory"
    );
    let completed = false;
    let raw;
    try {
      raw = await runCapturePhase({
        kind: plan.kind,
        captureId,
        clone,
        profile,
        fixture: plan.fixture,
        fixturePath: fixturePaths[plan.fixture.format],
        kernel,
        pythonPath,
        editor,
        driver,
        expectedDriver: specification.provenance.comparisonDriver,
        expectedExtensions,
        expectedTemplate,
        context,
        dependencies
      });
      const evidence = evidenceFromPhase(raw, context, plan.kind);
      if (plan.kind === "capability") {
        const receipt = createDataWranglerPolarsCapabilityReceipt(evidence, context);
        if (raw.conclusion !== "available") {
          fail(`Data Wrangler did not expose a stable Polars action for ${plan.fixture.id}.`);
        }
        capabilities.push({
          product: "data-wrangler",
          engine: "polars",
          availability: "available",
          method: "public-capability",
          timed: false,
          fixtureId: plan.fixture.id,
          context,
          receiptSha256: digestStudyValue(receipt),
          receipt
        });
      } else {
        const receipt = createNeitherProductControlReceipt(evidence, context);
        if (raw.conclusion !== "neither-product-control") fail("Neither-product control was not conclusive.");
        controlProfile = {
          method: "neither-product",
          fixtureId: plan.fixture.id,
          context,
          receiptSha256: digestStudyValue(receipt),
          receipt
        };
      }
      bindings.push({
        kind: plan.kind,
        fixtureId: plan.fixture.id,
        captureId,
        editorSha256: publicEditor.sha256,
        templateProduct: "data-wrangler",
        templateKind: "configured-only",
        templateTreeSha256,
        phaseReceiptSha256: digestStudyValue(raw),
        phaseReceipt: structuredClone(raw)
      });
      completed = true;
    } finally {
      if (completed) dependencies.retireClone(clone);
    }
  }
  if (capabilities.length !== specification.fixtures.length || controlProfile === undefined) {
    fail("Public-UI preparation did not capture every capability and control receipt.");
  }
  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    controlProfile: Object.freeze(controlProfile),
    bindings: Object.freeze(bindings)
  });
}
