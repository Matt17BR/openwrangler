import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const maximumSourceBytes = 2 * 1024 * 1024;
const maximumAggregateSourceBytes = 16 * 1024 * 1024;
const maximumProductionSourceFiles = 2_048;
const maximumProductionDirectoryEntries = 8_192;
const maximumProductionDirectoryDepth = 32;
const maximumManifestContributions = 4_096;
const maximumViewContributionGroups = 256;
const maximumSyntaxTokens = 500_000;
const maximumSyntaxNesting = 512;
const maximumSyntaxNodes = 250_000;
const maximumActivationChildOutputBytes = 64 * 1024;
const activationMeasurementChildFlag = "--measure-dependency-free-activation-child";
const execFileAsync = promisify(execFile);
export const maximumDependencyFreeActivationMs = 2_000;

export const activationTriggerContract = defineActivationTriggerContract({
  unrelated: {
    events: [],
    roots: ["src/extension/activate.ts"],
    maximumModules: 3,
    maximumBytes: 64 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  utility: {
    events: [
      "onCommand:openWrangler.openWalkthrough",
      "onCommand:openWrangler.openSettings",
      "onCommand:openWrangler.reportIssue"
    ],
    roots: ["src/extension/activate.ts"],
    maximumModules: 3,
    maximumBytes: 64 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "notebook-preview": {
    events: ["onCommand:openWrangler.chooseNotebookPreviewProvider"],
    roots: ["src/extension/activate.ts", "src/extension/notebooks/notebookPreviewCoordinator.ts"],
    maximumModules: 24,
    maximumBytes: 320 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  notebook: {
    events: [
      "onCommand:openWrangler.launchDataViewer",
      "onCommand:openWrangler.openNotebookVariable",
      "onCommand:openWrangler.openNotebookCellResult",
      "onCommand:openWrangler.runPythonCellAndOpenVariable",
      "onCommand:openWrangler.refreshNotebookVariables",
      "onCommand:openWrangler.openCachedNotebookVariable",
      "onCommand:openWrangler.checkJupyterIntegration",
      "onRenderer:openWrangler.renderer",
      "onNotebook:jupyter-notebook",
      "onNotebook:interactive"
    ],
    roots: [
      "src/extension/activate.ts",
      "src/extension/sessionCoordinator.ts",
      "src/extension/notebooks/notebookPreviewCoordinator.ts",
      "src/extension/notebooks/pythonInteractiveCommands.ts",
      "src/extension/notebooks/jupyterBridge.ts",
      "src/extension/notebooks/notebookCellResult.ts",
      "src/extension/notebooks/rendererMessaging.ts"
    ],
    maximumModules: 90,
    maximumBytes: 1536 * 1024,
    forbidden: ["pythonBridge.ts", "r/rInteractiveCommands.ts", "files/fileOpen.ts", "nativeViews.ts"]
  },
  runtime: {
    events: [
      "onCommand:openWrangler.changeRuntime",
      "onCommand:openWrangler.clearRuntime",
      "onCommand:openWrangler.installRuntimeDependencies",
      "onCommand:openWrangler.revalidateRuntimeDependencies"
    ],
    roots: ["src/extension/activate.ts", "src/extension/pythonBridge.ts", "src/extension/runtimeCommands.ts"],
    maximumModules: 36,
    maximumBytes: 512 * 1024,
    forbidden: ["r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "trusted-pickle": {
    events: ["onCommand:openWrangler.convertTrustedPickle"],
    roots: [
      "src/extension/activate.ts",
      "src/extension/pythonBridge.ts",
      "src/extension/files/trustedPickleConversion.ts",
      "src/extension/files/trustedPickleWorker.ts"
    ],
    maximumModules: 48,
    maximumBytes: 640 * 1024,
    forbidden: ["r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  r: {
    events: [
      "onCommand:openWrangler.openRDataframe",
      "onCommand:openWrangler.openRInteractiveVariable",
      "onCommand:openWrangler.refreshRInteractiveVariables",
      "onCommand:openWrangler.openCachedRInteractiveVariable"
    ],
    roots: [
      "src/extension/activate.ts",
      "src/extension/sessionCoordinator.ts",
      "src/extension/r/rInteractiveCommands.ts"
    ],
    maximumModules: 90,
    maximumBytes: 1600 * 1024,
    forbidden: ["pythonBridge.ts", "notebooks/pythonInteractiveCommands.ts", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "r-document": {
    events: ["onCommand:openWrangler.runRDocument"],
    roots: [
      "src/extension/activate.ts",
      "src/extension/sessionCoordinator.ts",
      "src/extension/notebooks/notebookPreviewCoordinator.ts",
      "src/extension/notebooks/pythonInteractiveCommands.ts",
      "src/extension/notebooks/jupyterBridge.ts",
      "src/extension/notebooks/notebookCellResult.ts",
      "src/extension/notebooks/rendererMessaging.ts",
      "src/extension/r/rInteractiveCommands.ts",
      "src/extension/r/rDocumentCommands.ts"
    ],
    maximumModules: 110,
    maximumBytes: 1920 * 1024,
    forbidden: ["pythonBridge.ts", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "custom-editor": {
    events: [
      "onCommand:openWrangler.openFile",
      "onCommand:openWrangler.changeImportOptions",
      "onCommand:openWrangler.openPath",
      "onCustomEditor:openWrangler.viewer"
    ],
    roots: [
      "src/extension/activate.ts",
      "src/extension/sessionCoordinator.ts",
      "src/extension/pythonBridge.ts",
      "src/extension/files/fileOpen.ts"
    ],
    maximumModules: 64,
    maximumBytes: 832 * 1024,
    forbidden: ["r/", "notebooks/pythonInteractiveCommands.ts", "nativeViews.ts"]
  },
  "native-view": {
    events: [
      "onCommand:openWrangler.startOperation",
      "onCommand:openWrangler.applyStep",
      "onCommand:openWrangler.discardStep",
      "onCommand:openWrangler.editLatestStep",
      "onCommand:openWrangler.editSelectedStep",
      "onCommand:openWrangler.deleteSelectedStep",
      "onCommand:openWrangler.selectStep",
      "onCommand:openWrangler.undoStep",
      "onCommand:openWrangler.openViewSort",
      "onCommand:openWrangler.moveViewSortUp",
      "onCommand:openWrangler.moveViewSortDown",
      "onCommand:openWrangler.removeViewSort",
      "onCommand:openWrangler.copyCode",
      "onCommand:openWrangler.exportCode",
      "onCommand:openWrangler.insertNotebookCode",
      "onCommand:openWrangler.insertRDocumentCode",
      "onCommand:openWrangler.exportData",
      "onCommand:openWrangler.openSourceFile",
      "onView:openWrangler.summary",
      "onView:openWrangler.filters",
      "onView:openWrangler.cleaningSteps",
      "onView:openWrangler.codePreview"
    ],
    roots: ["src/extension/activate.ts", "src/extension/sessionCoordinator.ts", "src/extension/nativeViews.ts"],
    maximumModules: 96,
    maximumBytes: 1700 * 1024,
    forbidden: [
      "pythonBridge.ts",
      "files/fileOpen.ts",
      "notebooks/pythonInteractiveCommands.ts",
      "r/rInteractiveCommands.ts"
    ]
  },
  "native-live": {
    events: ["onCommand:openWrangler.refreshLiveDataframes", "onView:openWrangler.operations"],
    roots: [
      "src/extension/activate.ts",
      "src/extension/sessionCoordinator.ts",
      "src/extension/notebooks/notebookPreviewCoordinator.ts",
      "src/extension/notebooks/pythonInteractiveCommands.ts",
      "src/extension/notebooks/jupyterBridge.ts",
      "src/extension/notebooks/notebookCellResult.ts",
      "src/extension/notebooks/rendererMessaging.ts",
      "src/extension/r/rInteractiveCommands.ts",
      "src/extension/nativeViews.ts"
    ],
    maximumModules: 105,
    maximumBytes: 1920 * 1024,
    forbidden: ["pythonBridge.ts", "files/fileOpen.ts"]
  },
  "test-api": {
    events: [],
    roots: ["src/extension/activate.ts"],
    maximumModules: 120,
    maximumBytes: 2 * 1024 * 1024,
    forbidden: []
  }
});

export const activationTriggerBudgets = Object.freeze(
  Object.fromEntries(
    Object.entries(activationTriggerContract).map(([trigger, { events: _events, ...budget }]) => [
      trigger,
      Object.freeze(budget)
    ])
  )
);

export const activationEventClassifications = classifyActivationEvents(
  Object.fromEntries(Object.entries(activationTriggerContract).map(([trigger, contract]) => [trigger, contract.events]))
);

export const dynamicEdgeClassifications = freezeClassifications({
  "src/extension/lazyActivationOwners.ts|require|./notebooks/notebookPreviewCoordinator": [
    "notebook-preview",
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./sessionCoordinator": [
    "notebook",
    "r",
    "r-document",
    "custom-editor",
    "native-view",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./pythonBridge": [
    "runtime",
    "trusted-pickle",
    "custom-editor",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./files/fileOpen": ["custom-editor", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./files/trustedPickleConversion": ["trusted-pickle", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./files/trustedPickleWorker": ["trusted-pickle", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./notebooks/pythonInteractiveCommands": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./notebooks/jupyterBridge": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./notebooks/notebookCellResult": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./notebooks/rendererMessaging": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./r/rInteractiveCommands": [
    "r",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|require|./r/rDocumentCommands": ["r-document", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./runtimeCommands": ["runtime", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./nativeViews": ["native-view", "native-live", "test-api"],
  "src/extension/lazyActivationOwners.ts|require|./webviewPanel": ["test-api"]
});

export async function measureActivationTriggers(repositoryRoot = defaultRepositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const measurements = {};
  for (const [trigger, budget] of Object.entries(activationTriggerBudgets)) {
    const classifiedDynamicRoots = await dynamicRootsForTrigger(root, trigger);
    const discovery = await discoverTransitiveRuntimeSources(root, [
      ...new Set([...budget.roots, ...classifiedDynamicRoots])
    ]);
    const relativeFiles = [...discovery.files].map((file) => toPosix(path.relative(root, file))).sort();
    measurements[trigger] = {
      modules: discovery.files.size,
      bytes: discovery.bytes,
      files: relativeFiles,
      classifiedDynamicRoots,
      forbiddenMatches: budget.forbidden.flatMap((needle) =>
        relativeFiles.filter((file) => matchesOwnerNeedle(file, needle)).map((file) => ({ needle, file }))
      )
    };
  }
  const { dynamicEdges, activationEvents } = await measureActivationInventory(root);
  const elapsedActivation = await measureDependencyFreeActivation(root);
  dynamicEdges.closureMismatches = Object.entries(measurements).flatMap(([trigger, measurement]) =>
    measurement.classifiedDynamicRoots
      .filter((target) => !measurement.files.includes(target))
      .map((target) => ({ trigger, target }))
  );
  return {
    metric: "classified-trigger-runtime-source-closure",
    repositoryRoot: root,
    measurements,
    elapsedActivation,
    dynamicEdges,
    activationEvents
  };
}

export async function measureActivationInventory(repositoryRoot = defaultRepositoryRoot, options = {}) {
  const root = path.resolve(repositoryRoot);
  return {
    dynamicEdges: await measureDynamicEdges(root, options),
    activationEvents: await measureActivationEvents(root)
  };
}

export async function measureTransitiveRuntimeSources(repositoryRoot, roots, options = {}) {
  const root = path.resolve(repositoryRoot);
  const discovery = await discoverTransitiveRuntimeSources(root, roots, options);
  return {
    files: [...discovery.files].map((file) => toPosix(path.relative(root, file))).sort(),
    bytes: discovery.bytes
  };
}

export async function measureDependencyFreeActivation(
  repositoryRoot = defaultRepositoryRoot,
  { synchronousRegistrationDelayMs = 0 } = {}
) {
  if (
    !Number.isSafeInteger(synchronousRegistrationDelayMs) ||
    synchronousRegistrationDelayMs < 0 ||
    synchronousRegistrationDelayMs > maximumDependencyFreeActivationMs + 1
  ) {
    throw new Error("Dependency-free activation delay injection is outside its bounded test range.");
  }
  const root = path.resolve(repositoryRoot);
  const startedAt = globalThis.performance.now();
  let childMeasurement;
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [fileURLToPath(import.meta.url), activationMeasurementChildFlag, root, String(synchronousRegistrationDelayMs)],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: maximumActivationChildOutputBytes,
        timeout: maximumDependencyFreeActivationMs + 10_000,
        windowsHide: true
      }
    );
    childMeasurement = parseActivationChildMeasurement(stdout, stderr);
  } catch (error) {
    childMeasurement = { failure: boundedActivationFailure(error) };
  }
  const elapsedMs = Math.max(0, globalThis.performance.now() - startedAt);
  const failure =
    childMeasurement.failure ??
    (elapsedMs > maximumDependencyFreeActivationMs
      ? `Cold dependency-free activation exceeded its ${maximumDependencyFreeActivationMs} ms elapsed budget.`
      : undefined);
  return {
    elapsedMs,
    maximumMs: maximumDependencyFreeActivationMs,
    withinBudget: failure === undefined,
    ...(failure === undefined ? {} : { failure })
  };
}

async function measureDependencyFreeActivationInProcess(repositoryRoot, synchronousRegistrationDelayMs) {
  const root = path.resolve(repositoryRoot);
  const aggregateBudget = boundedAggregateBudget(maximumAggregateSourceBytes);
  const [activateSource, ownersSource] = await Promise.all([
    readBoundedRegularFile(root, path.resolve(root, "src/extension/activate.ts"), aggregateBudget),
    readBoundedRegularFile(root, path.resolve(root, "src/extension/lazyActivationOwners.ts"), aggregateBudget)
  ]);
  let delayInjected = false;
  const disposable = () => ({ dispose: () => undefined });
  const register = () => {
    if (!delayInjected) {
      delayInjected = true;
      const delayEndsAt = globalThis.performance.now() + synchronousRegistrationDelayMs;
      while (globalThis.performance.now() < delayEndsAt) {
        // Deliberately synchronous: the child process makes the elapsed gate
        // observe injected registration work without stalling the test runner.
      }
    }
    return disposable();
  };
  const vscode = {
    commands: { registerCommand: register, executeCommand: async () => undefined },
    env: { appName: "Visual Studio Code", openExternal: async () => true },
    window: {
      visibleNotebookEditors: [],
      registerCustomEditorProvider: register,
      registerTreeDataProvider: register,
      registerWebviewViewProvider: register,
      onDidChangeVisibleNotebookEditors: register,
      onDidChangeActiveNotebookEditor: register,
      showErrorMessage: async () => undefined
    },
    workspace: {
      notebookDocuments: [],
      onDidOpenNotebookDocument: register,
      onDidGrantWorkspaceTrust: register
    },
    Uri: { parse: (value) => value },
    version: "activation-budget"
  };
  const sandbox = {
    AggregateError,
    console,
    performance: globalThis.performance,
    process: { env: {}, platform: process.platform },
    Promise,
    setTimeout,
    clearTimeout
  };
  const owners = evaluateCommonJs(ownersSource.source, "src/extension/lazyActivationOwners.ts", sandbox, (id) => {
    if (id === "vscode") return vscode;
    throw new Error(`Dependency-free activation unexpectedly loaded ${id}.`);
  });
  const activation = evaluateCommonJs(activateSource.source, "src/extension/activate.ts", sandbox, (id) => {
    if (id === "vscode") return vscode;
    if (id === "./lazyActivationOwners") return owners;
    throw new Error(`Dependency-free activation unexpectedly loaded ${id}.`);
  });
  const context = { subscriptions: [] };
  let failure;
  try {
    await activation.activate(context);
  } catch (error) {
    failure = boundedActivationFailure(error);
  } finally {
    try {
      await activation.deactivate();
    } catch (error) {
      failure ??= boundedActivationFailure(error);
    }
  }
  const declaredMaximumMs = activation.MAX_SYNCHRONOUS_ACTIVATION_MS;
  if (declaredMaximumMs !== maximumDependencyFreeActivationMs) {
    failure = `Activation declares ${String(declaredMaximumMs)} ms instead of ${maximumDependencyFreeActivationMs} ms.`;
  }
  return failure === undefined ? {} : { failure };
}

function parseActivationChildMeasurement(stdout, stderr) {
  if (Buffer.byteLength(stdout, "utf8") > maximumActivationChildOutputBytes || stderr.length > 0) {
    throw new Error("Dependency-free activation child emitted unexpected or oversized output.");
  }
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Dependency-free activation child emitted an invalid receipt.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Dependency-free activation child emitted a malformed receipt.");
  }
  if (Object.keys(value).some((key) => key !== "failure")) {
    throw new Error("Dependency-free activation child emitted an unexpected receipt field.");
  }
  if (value.failure !== undefined && (typeof value.failure !== "string" || value.failure.length > 512)) {
    throw new Error("Dependency-free activation child emitted an invalid failure.");
  }
  return value;
}

function boundedActivationFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/gu, " ").slice(0, 512);
}

export function activationBudgetFailures(report, budgets = activationTriggerBudgets) {
  const failures = [];
  for (const [trigger, budget] of Object.entries(budgets)) {
    const measurement = report.measurements[trigger];
    if (!measurement) {
      failures.push(`${trigger}: missing measurement`);
      continue;
    }
    if (measurement.modules > budget.maximumModules) {
      failures.push(`${trigger}: ${measurement.modules} modules exceeds ${budget.maximumModules}`);
    }
    if (measurement.bytes > budget.maximumBytes) {
      failures.push(`${trigger}: ${measurement.bytes} bytes exceeds ${budget.maximumBytes}`);
    }
    for (const match of measurement.forbiddenMatches) {
      failures.push(`${trigger}: unexpectedly loads ${match.file} through exclusion ${match.needle}`);
    }
  }
  if (!report.elapsedActivation) {
    failures.push("elapsed activation: missing dependency-free measurement");
  } else if (
    report.elapsedActivation.maximumMs !== maximumDependencyFreeActivationMs ||
    !Number.isFinite(report.elapsedActivation.elapsedMs) ||
    report.elapsedActivation.elapsedMs < 0 ||
    !report.elapsedActivation.withinBudget
  ) {
    failures.push(
      `elapsed activation: ${report.elapsedActivation.failure ?? `${String(report.elapsedActivation.elapsedMs)} ms exceeds ${maximumDependencyFreeActivationMs} ms`}`
    );
  }
  if (!report.dynamicEdges) {
    failures.push("dynamic edges: missing independent production-edge inventory");
  } else {
    for (const edge of report.dynamicEdges.unclassified) failures.push(`dynamic edge: unclassified ${edge}`);
    for (const edge of report.dynamicEdges.staleClassifications)
      failures.push(`dynamic edge: stale classification ${edge}`);
    for (const mismatch of report.dynamicEdges.occurrenceMismatches) {
      failures.push(`dynamic edge: ${mismatch.key} occurs ${mismatch.actual} times instead of ${mismatch.expected}`);
    }
    for (const trigger of report.dynamicEdges.unknownTriggerClasses) {
      failures.push(`dynamic edge: unknown trigger class ${trigger}`);
    }
    for (const mismatch of report.dynamicEdges.closureMismatches ?? []) {
      failures.push(`dynamic edge: ${mismatch.target} is absent from the ${mismatch.trigger} trigger closure`);
    }
  }
  if (!report.activationEvents) {
    failures.push("activation events: missing independent package-event inventory");
  } else {
    for (const event of report.activationEvents.unclassified) failures.push(`activation event: unclassified ${event}`);
    for (const event of report.activationEvents.staleClassifications)
      failures.push(`activation event: stale classification ${event}`);
    for (const mismatch of report.activationEvents.occurrenceMismatches) {
      failures.push(`activation event: ${mismatch.event} occurs ${mismatch.actual} times instead of 1`);
    }
    for (const mismatch of report.activationEvents.contributedCommandOccurrenceMismatches) {
      failures.push(`contributed command: ${mismatch.command} occurs ${mismatch.actual} times instead of 1`);
    }
    for (const mismatch of report.activationEvents.contributedViewOccurrenceMismatches) {
      failures.push(`contributed view: ${mismatch.view} occurs ${mismatch.actual} times instead of 1`);
    }
    for (const mismatch of report.activationEvents.contributedCustomEditorOccurrenceMismatches) {
      failures.push(`contributed custom editor: ${mismatch.viewType} occurs ${mismatch.actual} times instead of 1`);
    }
    for (const trigger of report.activationEvents.unknownTriggerClasses) {
      failures.push(`activation event: unknown trigger class ${trigger}`);
    }
  }
  return failures;
}

function evaluateCommonJs(source, file, sandbox, requireModule) {
  preflightTypeScriptSyntax(source, file, {});
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    },
    fileName: file,
    reportDiagnostics: true
  });
  const diagnostic = output.diagnostics?.find((entry) => entry.category === ts.DiagnosticCategory.Error);
  if (diagnostic) throw new Error(`Dependency-free activation could not transpile ${file} (TS${diagnostic.code}).`);
  const module = { exports: {} };
  const context = vm.createContext({ ...sandbox });
  const wrapper = new vm.Script(`(function (exports, require, module) { ${output.outputText}\n})`, {
    filename: file
  }).runInContext(context);
  wrapper(module.exports, requireModule, module);
  return module.exports;
}

async function dynamicRootsForTrigger(repositoryRoot, trigger) {
  const roots = [];
  for (const [key, classification] of Object.entries(dynamicEdgeClassifications)) {
    if (!classification.triggers.includes(trigger)) continue;
    const [relativeImporter, _kind, specifier, ...extra] = key.split("|");
    if (extra.length > 0 || !relativeImporter || !specifier) {
      throw new Error(`Dynamic edge classification has an invalid key: ${key}`);
    }
    if (!specifier.startsWith(".")) continue;
    const importer = path.resolve(repositoryRoot, relativeImporter);
    const resolved = await resolveTypescriptImport(repositoryRoot, importer, specifier);
    if (!resolved) throw new Error(`Dynamic edge classification target is unavailable: ${key}`);
    roots.push(toPosix(path.relative(repositoryRoot, resolved)));
  }
  return [...new Set(roots)].sort();
}

async function measureDynamicEdges(repositoryRoot, options = {}) {
  const sourceRoot = path.resolve(repositoryRoot, "src/extension");
  const sourceFiles = await productionTypescriptSources(repositoryRoot, sourceRoot, options);
  const occurrenceCounts = new Map();
  const aggregateBudget = boundedAggregateBudget(maximumAggregateSourceBytes);
  for (const file of sourceFiles) {
    const { source } = await readBoundedRegularFile(repositoryRoot, file, aggregateBudget);
    const relativeFile = toPosix(path.relative(repositoryRoot, file));
    for (const edge of syntaxRuntimeInventory(source, file, options).dynamicEdges) {
      const key = `${relativeFile}|${edge.kind}|${edge.specifier}`;
      occurrenceCounts.set(key, (occurrenceCounts.get(key) ?? 0) + 1);
    }
  }
  const discovered = [...occurrenceCounts].map(([key, occurrences]) => ({ key, occurrences }));
  discovered.sort((left, right) => left.key.localeCompare(right.key));
  const classifiedKeys = Object.keys(dynamicEdgeClassifications).sort();
  const unclassified = discovered
    .filter(({ key }) => dynamicEdgeClassifications[key] === undefined)
    .map(({ key }) => key);
  const staleClassifications = classifiedKeys.filter((key) => !occurrenceCounts.has(key));
  const occurrenceMismatches = discovered
    .filter(
      ({ key, occurrences }) =>
        dynamicEdgeClassifications[key] !== undefined && occurrences !== dynamicEdgeClassifications[key].occurrences
    )
    .map(({ key, occurrences }) => ({
      key,
      expected: dynamicEdgeClassifications[key].occurrences,
      actual: occurrences
    }));
  const knownTriggerClasses = new Set(Object.keys(activationTriggerBudgets));
  const unknownTriggerClasses = [
    ...new Set(Object.values(dynamicEdgeClassifications).flatMap(({ triggers }) => triggers))
  ]
    .filter((trigger) => !knownTriggerClasses.has(trigger))
    .sort();
  return {
    scannedSourceFiles: sourceFiles.length,
    discovered,
    classified: classifiedKeys,
    unclassified,
    staleClassifications,
    occurrenceMismatches,
    unknownTriggerClasses
  };
}

async function measureActivationEvents(repositoryRoot) {
  const packageFile = path.resolve(repositoryRoot, "package.json");
  const { source } = await readBoundedRegularFile(repositoryRoot, packageFile);
  const manifest = JSON.parse(source);
  if (
    !Array.isArray(manifest.activationEvents) ||
    !manifest.activationEvents.every((event) => typeof event === "string" && event.length > 0 && event.length <= 512)
  ) {
    throw new Error("package.json activationEvents must be a bounded string array.");
  }
  const explicit = [...manifest.activationEvents].sort();
  const contributions = manifest.contributes;
  if (!isRecord(contributions)) throw new Error("package.json contributes must be an object.");
  const contributedCommands = contributionIds(contributions.commands, "command", "commands", true);
  const contributedViews = viewContributionIds(contributions.views);
  const contributedCustomEditors = contributionIds(contributions.customEditors, "viewType", "customEditors", false);
  const contributionDerived = [
    ...contributedCommands.map((command) => `onCommand:${command}`),
    ...contributedViews.map((view) => `onView:${view}`),
    ...contributedCustomEditors.map((viewType) => `onCustomEditor:${viewType}`)
  ].sort();
  const discovered = [...new Set([...explicit, ...contributionDerived])].sort();
  const classified = Object.keys(activationEventClassifications).sort();
  const discoveredSet = new Set(discovered);
  const occurrenceCounts = new Map();
  for (const event of explicit) occurrenceCounts.set(event, (occurrenceCounts.get(event) ?? 0) + 1);
  const contributedCommandCounts = new Map();
  for (const command of contributedCommands) {
    contributedCommandCounts.set(command, (contributedCommandCounts.get(command) ?? 0) + 1);
  }
  const contributedViewCounts = occurrenceCountsFor(contributedViews);
  const contributedCustomEditorCounts = occurrenceCountsFor(contributedCustomEditors);
  const unclassified = discovered.filter((event) => activationEventClassifications[event] === undefined);
  const staleClassifications = classified.filter((event) => !discoveredSet.has(event));
  const occurrenceMismatches = [...occurrenceCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([event, actual]) => ({ event, actual }));
  const contributedCommandOccurrenceMismatches = [...contributedCommandCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([command, actual]) => ({ command, actual }));
  const contributedViewOccurrenceMismatches = [...contributedViewCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([view, actual]) => ({ view, actual }));
  const contributedCustomEditorOccurrenceMismatches = [...contributedCustomEditorCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([viewType, actual]) => ({ viewType, actual }));
  const knownTriggerClasses = new Set(Object.keys(activationTriggerBudgets));
  const unknownTriggerClasses = [...new Set(Object.values(activationEventClassifications))]
    .filter((trigger) => !knownTriggerClasses.has(trigger))
    .sort();
  return {
    explicit,
    contributedCommands,
    contributedViews,
    contributedCustomEditors,
    contributionDerived,
    discovered,
    classified,
    unclassified,
    staleClassifications,
    occurrenceMismatches,
    contributedCommandOccurrenceMismatches,
    contributedViewOccurrenceMismatches,
    contributedCustomEditorOccurrenceMismatches,
    unknownTriggerClasses
  };
}

function contributionIds(value, key, label, required) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > maximumManifestContributions) {
    throw new Error(`package.json contributes.${label} must be a bounded array.`);
  }
  return value
    .map((contribution) => {
      if (!isRecord(contribution) || !boundedContributionId(contribution[key])) {
        throw new Error(`package.json contributes.${label} contains an invalid ${key}.`);
      }
      return contribution[key];
    })
    .sort();
}

function viewContributionIds(value) {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.keys(value).length > maximumViewContributionGroups) {
    throw new Error("package.json contributes.views must be a bounded object of arrays.");
  }
  const views = [];
  for (const contributions of Object.values(value)) {
    if (!Array.isArray(contributions) || views.length + contributions.length > maximumManifestContributions) {
      throw new Error("package.json contributes.views must contain bounded arrays.");
    }
    for (const contribution of contributions) {
      if (!isRecord(contribution) || !boundedContributionId(contribution.id)) {
        throw new Error("package.json contributes.views contains an invalid id.");
      }
      views.push(contribution.id);
    }
  }
  return views.sort();
}

function boundedContributionId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function occurrenceCountsFor(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

async function discoverTransitiveRuntimeSources(
  repositoryRoot,
  roots,
  {
    maximumAggregateBytes = maximumAggregateSourceBytes,
    afterDescriptorOpen,
    afterDescriptorRead,
    ...syntaxOptions
  } = {}
) {
  const pending = roots.map((root) => path.resolve(repositoryRoot, root));
  const visited = new Set();
  const aggregateBudget = boundedAggregateBudget(maximumAggregateBytes);
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const { source } = await readBoundedRegularFile(repositoryRoot, file, aggregateBudget, {
      afterDescriptorOpen,
      afterDescriptorRead
    });
    visited.add(file);
    for (const specifier of syntaxRuntimeInventory(source, file, syntaxOptions).staticSpecifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveTypescriptImport(repositoryRoot, file, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return { files: visited, bytes: aggregateBudget.used };
}

async function productionTypescriptSources(repositoryRoot, sourceRoot, options = {}) {
  assertContained(repositoryRoot, sourceRoot);
  const maximumEntries = boundedUpperLimit(
    options.maximumDirectoryEntries ?? maximumProductionDirectoryEntries,
    maximumProductionDirectoryEntries,
    "directory entries"
  );
  const maximumDepth = boundedUpperLimit(
    options.maximumDirectoryDepth ?? maximumProductionDirectoryDepth,
    maximumProductionDirectoryDepth,
    "directory depth",
    true
  );
  const pending = [{ directory: sourceRoot, depth: 0 }];
  const files = [];
  let entries = 0;
  while (pending.length > 0) {
    const { directory, depth } = pending.pop();
    const directoryHandle = await opendir(directory);
    for await (const entry of directoryHandle) {
      entries += 1;
      if (entries > maximumEntries) {
        throw new Error(`Production source inventory exceeds ${maximumEntries} directory entries.`);
      }
      const candidate = path.join(directory, entry.name);
      assertContained(repositoryRoot, candidate);
      if (entry.isSymbolicLink()) throw new Error(`Production source inventory encountered a symlink: ${candidate}`);
      if (entry.isDirectory()) {
        if (depth >= maximumDepth) {
          throw new Error(`Production source inventory exceeds directory depth ${maximumDepth}: ${candidate}`);
        }
        pending.push({ directory: candidate, depth: depth + 1 });
      } else if (entry.isFile() && /\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) {
        files.push(candidate);
        if (files.length > maximumProductionSourceFiles) {
          throw new Error(`Production source inventory exceeds ${maximumProductionSourceFiles} files.`);
        }
      }
    }
  }
  return files.sort();
}

async function readBoundedRegularFile(
  repositoryRoot,
  file,
  aggregateBudget = boundedAggregateBudget(maximumAggregateSourceBytes),
  { afterDescriptorOpen, afterDescriptorRead } = {}
) {
  assertContained(repositoryRoot, file);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow | nonBlocking);
  } catch (error) {
    if (error?.code === "ELOOP") throw new Error(`Activation inventory source became a symlink: ${file}`);
    throw error;
  }
  try {
    await afterDescriptorOpen?.(file);
    const descriptorStat = await handle.stat({ bigint: true });
    if (!descriptorStat.isFile() || descriptorStat.nlink !== 1n || descriptorStat.size > BigInt(maximumSourceBytes)) {
      throw new Error(`Activation inventory source is not a bounded regular file: ${file}`);
    }
    const canonicalBefore = await canonicalContainedPath(repositoryRoot, file);
    const [pathBefore, rootBefore] = await Promise.all([
      lstat(file, { bigint: true }),
      lstat(canonicalBefore.root, { bigint: true })
    ]);
    if (
      !rootBefore.isDirectory() ||
      pathBefore.isSymbolicLink() ||
      !pathBefore.isFile() ||
      pathBefore.nlink !== 1n ||
      !sameFileVersion(descriptorStat, pathBefore)
    ) {
      throw new Error(`Activation inventory source changed identity before read: ${file}`);
    }
    const size = Number(descriptorStat.size);
    reserveAggregateBytes(aggregateBudget, size);
    const content = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(64 * 1024, size - offset);
      assertBoundedRead(aggregateBudget, size, offset, length);
      const { bytesRead } = await handle.read(content, offset, length, offset);
      if (bytesRead === 0) throw new Error(`Activation inventory source changed size during read: ${file}`);
      offset += bytesRead;
    }
    await afterDescriptorRead?.(file);
    const [descriptorAfter, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(file, { bigint: true }),
      canonicalContainedPath(repositoryRoot, file)
    ]);
    const rootAfter = await lstat(canonicalAfter.root, { bigint: true });
    if (
      !descriptorAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      descriptorAfter.nlink !== 1n ||
      pathAfter.nlink !== 1n ||
      !sameFileVersion(descriptorStat, descriptorAfter) ||
      !sameFileVersion(descriptorAfter, pathAfter) ||
      !sameFileIdentity(rootBefore, rootAfter) ||
      canonicalAfter.root !== canonicalBefore.root ||
      canonicalAfter.file !== canonicalBefore.file ||
      descriptorAfter.size !== descriptorStat.size
    ) {
      throw new Error(`Activation inventory source changed identity during read: ${file}`);
    }
    return { source: content.toString("utf8"), bytes: size };
  } finally {
    await handle.close();
  }
}

function syntaxRuntimeInventory(source, file, options = {}) {
  preflightTypeScriptSyntax(source, file, options);
  let sourceFile;
  try {
    sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
  } catch (error) {
    if (error instanceof RangeError) {
      throw new Error(`Activation inventory source exceeds the bounded TypeScript parser depth: ${file}`);
    }
    throw error;
  }
  const parseDiagnostic = sourceFile.parseDiagnostics?.[0];
  if (parseDiagnostic) {
    throw new Error(`Activation inventory source has invalid TypeScript syntax (TS${parseDiagnostic.code}): ${file}`);
  }
  const syntaxNodes = boundedSyntaxNodes(sourceFile, file, options);
  const variableDeclarations = [];
  const functionDeclarations = [];
  const callExpressions = [];
  const staticSpecifiers = [];
  const importDeclarations = [];
  const importEqualsDeclarations = [];
  for (const node of syntaxNodes) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (importDeclarationLoadsAtRuntime(node)) staticSpecifiers.push(node.moduleSpecifier.text);
      importDeclarations.push(node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      exportDeclarationLoadsAtRuntime(node)
    ) {
      staticSpecifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (!node.isTypeOnly && expression && ts.isStringLiteral(expression)) staticSpecifiers.push(expression.text);
    }
    if (ts.isImportEqualsDeclaration(node)) importEqualsDeclarations.push(node);
    if (ts.isVariableDeclaration(node)) variableDeclarations.push(node);
    if (ts.isFunctionDeclaration(node)) functionDeclarations.push(node);
    if (ts.isCallExpression(node)) callExpressions.push(node);
  }

  const checker = lexicalBindingChecker(sourceFile, source, file);
  const origins = new Map();
  const wrapperCalls = new Set();
  const maximumDependencyEdges = boundedUpperLimit(
    options.maximumLoaderDependencyEdges ?? syntaxNodes.length,
    syntaxNodes.length,
    "loader dependency edges",
    true
  );
  const authority = createLoaderOriginAuthority(
    checker,
    origins,
    wrapperCalls,
    [...variableDeclarations, ...functionDeclarations],
    maximumDependencyEdges
  );
  for (const declaration of importDeclarations) collectCreateRequireImport(declaration, authority);
  propagateLoaderOrigins(authority);

  const importEqualsEscapes = unsupportedImportEqualsLoaderAliases(sourceFile, importEqualsDeclarations, authority);
  if (importEqualsEscapes.length > 0) {
    throw new Error(
      `Activation inventory rejects TypeScript import-equals loader aliases (${importEqualsEscapes.join(", ")}): ${file}`
    );
  }

  const exportedLoaderEscapes = exportedLoaderBindings(sourceFile, syntaxNodes, authority);
  if (exportedLoaderEscapes.length > 0) {
    throw new Error(
      `Activation inventory loader binding escapes through export (${exportedLoaderEscapes.join(", ")}): ${file}`
    );
  }

  const loaderEscapes = unsupportedLoaderAliasUses(sourceFile, syntaxNodes, authority);
  if (loaderEscapes.length > 0) {
    throw new Error(
      `Activation inventory loader alias escapes through unsupported use (${loaderEscapes.join(", ")}): ${file}`
    );
  }

  const dynamicEdges = [];
  for (const call of callExpressions) {
    if (wrapperCalls.has(call)) continue;
    const kind = loaderCallKind(call, authority);
    if (!kind) continue;
    const argument = call.arguments[0];
    dynamicEdges.push({
      kind,
      specifier:
        call.arguments.length === 1 && argument && ts.isStringLiteral(argument) ? argument.text : "<non-literal>"
    });
  }
  return { dynamicEdges, staticSpecifiers };
}

function createLoaderOriginAuthority(checker, origins, wrapperCalls, declarations, maximumDependencyEdges) {
  const dependents = new Map();
  let dependencyEdges = 0;
  for (const declaration of declarations) {
    for (const symbol of loaderDependencySymbols(declaration, checker)) {
      if (dependencyEdges >= maximumDependencyEdges) {
        throw new Error("Activation inventory loader dependency graph exceeded its linear edge bound.");
      }
      const entries = dependents.get(symbol) ?? [];
      entries.push(declaration);
      dependents.set(symbol, entries);
      dependencyEdges += 1;
    }
  }
  const propagationLimit = declarations.length + dependencyEdges;
  const authority = {
    checker,
    origins,
    wrapperCalls,
    dependents,
    declarationQueue: [],
    queuedDeclarations: new Set(),
    propagationLimit,
    propagationEnqueues: 0
  };
  for (const declaration of declarations) enqueueLoaderDeclaration(declaration, authority);
  return authority;
}

function exportedLoaderBindings(sourceFile, syntaxNodes, authority) {
  const escapes = [];
  const appendBinding = (name) => {
    if (ts.isIdentifier(name)) {
      const kind = identifierLoaderOrigin(name, authority);
      if (kind) escapes.push(`${name.text}:${kind}@${name.getStart(sourceFile)}`);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) appendBinding(element.name);
    }
  };

  for (const node of syntaxNodes) {
    if (ts.isVariableStatement(node) && hasExportModifier(node)) {
      for (const declaration of node.declarationList.declarations) appendBinding(declaration.name);
      continue;
    }
    if (ts.isFunctionDeclaration(node) && hasExportModifier(node)) {
      const wrapper = functionLoaderCall(node, authority);
      const kind = node.name ? identifierLoaderOrigin(node.name, authority) : wrapper?.kind;
      if (kind) escapes.push(`${node.name?.text ?? "default"}:${kind}@${node.getStart(sourceFile)}`);
      continue;
    }
    if (ts.isExportAssignment(node)) {
      const kind = loaderExpressionOrigin(node.expression, authority);
      if (kind) escapes.push(`default:${kind}@${node.getStart(sourceFile)}`);
      continue;
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.moduleSpecifier &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        if (node.isTypeOnly || element.isTypeOnly) continue;
        const symbol = authority.checker.getExportSpecifierLocalTargetSymbol(element);
        const kind = symbol ? authority.origins.get(symbol) : undefined;
        if (kind) escapes.push(`${element.name.text}:${kind}@${element.getStart(sourceFile)}`);
      }
    }
  }
  return escapes.slice(0, 32);
}

function hasExportModifier(node) {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function unsupportedImportEqualsLoaderAliases(sourceFile, declarations, authority) {
  const escapes = [];
  for (const declaration of declarations) {
    if (declaration.isTypeOnly) continue;
    const kind = importEqualsLoaderOrigin(declaration.moduleReference, authority);
    if (kind) escapes.push(`${declaration.name.text}:${kind}@${declaration.getStart(sourceFile)}`);
  }
  return escapes.slice(0, 32);
}

function importEqualsLoaderOrigin(moduleReference, authority) {
  if (ts.isExternalModuleReference(moduleReference)) {
    const expression = moduleReference.expression;
    return expression && ts.isStringLiteral(expression) && /^(?:node:)?module$/u.test(expression.text)
      ? "createRequireNamespace"
      : undefined;
  }
  return importEqualsEntityLoaderOrigin(moduleReference, authority);
}

function importEqualsEntityLoaderOrigin(entityName, authority) {
  if (ts.isIdentifier(entityName)) return identifierLoaderOrigin(entityName, authority);
  const owner = importEqualsEntityLoaderOrigin(entityName.left, authority);
  return owner === "createRequireNamespace" && entityName.right.text === "createRequire" ? "createRequire" : undefined;
}

function loaderDependencySymbols(declaration, checker) {
  const expression = loaderDependencyExpression(declaration);
  if (!expression) return [];
  const symbols = new Set();
  const pending = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (ts.isIdentifier(node) && isIdentifierExpressionReference(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) symbols.add(symbol);
    }
    const children = [];
    ts.forEachChild(node, (child) => children.push(child));
    for (const child of children) pending.push(child);
  }
  return symbols;
}

function loaderDependencyExpression(declaration) {
  if (ts.isVariableDeclaration(declaration)) {
    if (!declaration.initializer) return undefined;
    const initializer = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
      return callableLoaderDependencyExpression(initializer.parameters, initializer.body);
    }
    return ts.isCallExpression(initializer) ? initializer.expression : initializer;
  }
  if (ts.isFunctionDeclaration(declaration) && declaration.body) {
    return callableLoaderDependencyExpression(declaration.parameters, declaration.body);
  }
  return undefined;
}

function callableLoaderDependencyExpression(parameters, body) {
  if (parameters.length !== 1 || !ts.isIdentifier(parameters[0].name)) return undefined;
  let expression;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return undefined;
    expression = body.statements[0].expression;
  } else {
    expression = body;
  }
  if (!expression) return undefined;
  expression = unwrapExpression(expression);
  return ts.isCallExpression(expression) && expression.arguments.length === 1 ? expression.expression : undefined;
}

function propagateLoaderOrigins(authority) {
  let index = 0;
  while (index < authority.declarationQueue.length) {
    const declaration = authority.declarationQueue[index];
    index += 1;
    authority.queuedDeclarations.delete(declaration);
    if (ts.isVariableDeclaration(declaration)) {
      collectVariableLoaderOrigin(declaration, authority);
      continue;
    }
    if (!declaration.name) continue;
    const wrapper = functionLoaderCall(declaration, authority);
    if (!wrapper) continue;
    addBindingOrigin(declaration.name, wrapper.kind, authority);
    authority.wrapperCalls.add(wrapper.call);
  }
}

function enqueueLoaderDeclaration(declaration, authority) {
  if (authority.queuedDeclarations.has(declaration)) return;
  authority.propagationEnqueues += 1;
  if (authority.propagationEnqueues > authority.propagationLimit) {
    throw new Error("Activation inventory loader alias propagation exceeded its linear bound.");
  }
  authority.queuedDeclarations.add(declaration);
  authority.declarationQueue.push(declaration);
}

function unsupportedLoaderAliasUses(sourceFile, syntaxNodes, authority) {
  const escapes = [];
  for (const node of syntaxNodes) {
    if (ts.isIdentifier(node)) {
      const kind = identifierLoaderOrigin(node, authority);
      if (kind && !isSupportedLoaderUse(node, kind, authority)) {
        escapes.push(`${node.text}:${kind}@${node.getStart(sourceFile)}`);
      }
    } else if (isGlobalModuleRequireExpression(node, authority.checker)) {
      if (!isSupportedLoaderUse(node, "require", authority)) {
        escapes.push(`module.require:require@${node.getStart(sourceFile)}`);
      }
    } else if (isDestructuringLoaderAssignment(node, authority)) {
      escapes.push(`destructuring:reassignment@${node.getStart(sourceFile)}`);
    }
  }
  return escapes.slice(0, 32);
}

function isSupportedLoaderUse(loaderExpression, kind, authority) {
  const parent = loaderExpression.parent;
  if (
    ts.isIdentifier(loaderExpression) &&
    ((ts.isVariableDeclaration(parent) && parent.name === loaderExpression) ||
      (ts.isFunctionDeclaration(parent) && parent.name === loaderExpression) ||
      (ts.isImportClause(parent) && parent.name === loaderExpression) ||
      (ts.isImportSpecifier(parent) &&
        (parent.name === loaderExpression || parent.propertyName === loaderExpression)) ||
      (ts.isNamespaceImport(parent) && parent.name === loaderExpression) ||
      (ts.isBindingElement(parent) && (parent.name === loaderExpression || parent.propertyName === loaderExpression)))
  ) {
    return true;
  }

  const expression = outerWrappedExpression(loaderExpression);
  if (
    ts.isVariableDeclaration(expression.parent) &&
    expression.parent.initializer === expression &&
    ts.isIdentifier(expression.parent.name)
  ) {
    return true;
  }
  if (kind === "createRequireNamespace") {
    const factory = createRequireMemberExpression(expression, authority);
    return factory ? isSupportedCreateRequireFactoryUse(factory) : false;
  }
  if (kind === "createRequire") return isSupportedCreateRequireFactoryUse(expression);
  if (kind === "import" || kind === "require") {
    if (
      kind === "require" &&
      ts.isPropertyAccessExpression(expression.parent) &&
      expression.parent.expression === expression &&
      (expression.parent.name.text === "resolve" || expression.parent.name.text === "cache")
    ) {
      return true;
    }
    return ts.isCallExpression(expression.parent) && expression.parent.expression === expression;
  }
  return false;
}

function isSupportedCreateRequireFactoryUse(factoryExpression) {
  const factoryCallee = outerWrappedExpression(factoryExpression);
  const factoryCall = factoryCallee.parent;
  if (!ts.isCallExpression(factoryCall) || factoryCall.expression !== factoryCallee) return false;
  const assignedCall = outerWrappedExpression(factoryCall);
  return (
    ts.isVariableDeclaration(assignedCall.parent) &&
    assignedCall.parent.initializer === assignedCall &&
    ts.isIdentifier(assignedCall.parent.name)
  );
}

function boundedSyntaxNodes(sourceFile, file, options) {
  const maximumDepth = boundedUpperLimit(
    options.maximumSyntaxTreeDepth ?? maximumSyntaxNesting,
    maximumSyntaxNesting,
    "syntax tree depth",
    true
  );
  const nodes = [];
  const pending = [{ node: sourceFile, depth: 0 }];
  while (pending.length > 0) {
    const { node, depth } = pending.pop();
    if (depth > maximumDepth) {
      throw new Error(`Activation inventory source exceeds syntax tree depth ${maximumDepth}: ${file}`);
    }
    nodes.push(node);
    if (nodes.length > maximumSyntaxNodes) {
      throw new Error(`Activation inventory source exceeds ${maximumSyntaxNodes} syntax nodes: ${file}`);
    }
    const children = [];
    ts.forEachChild(node, (child) => {
      children.push(child);
    });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ node: children[index], depth: depth + 1 });
    }
  }
  return nodes;
}

function lexicalBindingChecker(sourceFile, source, file) {
  const compilerOptions = {
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2022
  };
  const host = {
    fileExists: (candidate) => candidate === file,
    getCanonicalFileName: (candidate) => candidate,
    getCurrentDirectory: () => path.dirname(file),
    getDefaultLibFileName: () => "",
    getDirectories: () => [],
    getNewLine: () => "\n",
    getSourceFile: (candidate) => (candidate === file ? sourceFile : undefined),
    readFile: (candidate) => (candidate === file ? source : undefined),
    useCaseSensitiveFileNames: () => true,
    writeFile: () => undefined
  };
  return ts.createProgram([file], compilerOptions, host).getTypeChecker();
}

function outerWrappedExpression(expression) {
  let current = expression;
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isTypeAssertionExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent)) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }
  return current;
}

function scriptKind(file) {
  return /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function preflightTypeScriptSyntax(source, file, options) {
  const maximumTokens = boundedUpperLimit(
    options.maximumSyntaxTokens ?? maximumSyntaxTokens,
    maximumSyntaxTokens,
    "syntax tokens"
  );
  const maximumNesting = boundedUpperLimit(
    options.maximumSyntaxNesting ?? maximumSyntaxNesting,
    maximumSyntaxNesting,
    "syntax nesting",
    true
  );
  const languageVariant = scriptKind(file) === ts.ScriptKind.TSX ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard;
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, languageVariant, source);
  let tokens = 0;
  let nesting = 0;
  while (true) {
    const token = scanner.scan();
    if (token === ts.SyntaxKind.EndOfFileToken) return;
    tokens += 1;
    if (tokens > maximumTokens) {
      throw new Error(`Activation inventory source exceeds ${maximumTokens} syntax tokens: ${file}`);
    }
    if (isOpeningToken(token)) {
      nesting += 1;
      if (nesting > maximumNesting) {
        throw new Error(`Activation inventory source exceeds syntax nesting ${maximumNesting}: ${file}`);
      }
    } else if (isClosingToken(token) && nesting > 0) {
      nesting -= 1;
    }
  }
}

function isOpeningToken(token) {
  return (
    token === ts.SyntaxKind.OpenBraceToken ||
    token === ts.SyntaxKind.OpenBracketToken ||
    token === ts.SyntaxKind.OpenParenToken
  );
}

function isClosingToken(token) {
  return (
    token === ts.SyntaxKind.CloseBraceToken ||
    token === ts.SyntaxKind.CloseBracketToken ||
    token === ts.SyntaxKind.CloseParenToken
  );
}

function importDeclarationLoadsAtRuntime(declaration) {
  const clause = declaration.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings?.elements.some((element) => !element.isTypeOnly) ?? false;
}

function exportDeclarationLoadsAtRuntime(declaration) {
  if (declaration.isTypeOnly) return false;
  if (!declaration.exportClause || ts.isNamespaceExport(declaration.exportClause)) return true;
  return declaration.exportClause.elements.some((element) => !element.isTypeOnly);
}

function collectCreateRequireImport(declaration, authority) {
  if (
    !ts.isStringLiteral(declaration.moduleSpecifier) ||
    !/^(?:node:)?module$/u.test(declaration.moduleSpecifier.text) ||
    !declaration.importClause ||
    declaration.importClause.isTypeOnly
  ) {
    return;
  }
  const clause = declaration.importClause;
  if (clause.name) addBindingOrigin(clause.name, "createRequireNamespace", authority);
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    addBindingOrigin(bindings.name, "createRequireNamespace", authority);
    return;
  }
  for (const element of bindings.elements) {
    if (bindingPropertyName(element) === "createRequire" && !element.isTypeOnly) {
      addBindingOrigin(element.name, "createRequire", authority);
    }
  }
}

function collectVariableLoaderOrigin(declaration, authority) {
  if (!declaration.initializer) return false;
  const initializer = unwrapExpression(declaration.initializer);
  if (ts.isIdentifier(declaration.name)) {
    if (isNodeModuleRequireCall(initializer, authority)) {
      return addBindingOrigin(declaration.name, "createRequireNamespace", authority);
    }
    if (ts.isCallExpression(initializer) && isCreateRequireCall(initializer, authority)) {
      return addBindingOrigin(declaration.name, "require", authority);
    }
    const wrapper = wrapperLoaderCall(initializer, authority);
    if (wrapper) {
      authority.wrapperCalls.add(wrapper.call);
      return addBindingOrigin(declaration.name, wrapper.kind, authority);
    }
    const origin = loaderExpressionOrigin(initializer, authority);
    return origin ? addBindingOrigin(declaration.name, origin, authority) : false;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return false;
  let sourceKind;
  if (isNodeModuleRequireCall(initializer, authority)) sourceKind = "createRequireNamespace";
  else if (isGlobalModuleIdentifier(initializer, authority.checker)) sourceKind = "commonJsModule";
  else sourceKind = loaderExpressionOrigin(initializer, authority);
  if (sourceKind !== "createRequireNamespace" && sourceKind !== "commonJsModule") return false;
  let changed = false;
  for (const element of declaration.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const propertyName = bindingPropertyName(element);
    if (sourceKind === "createRequireNamespace" && propertyName === "createRequire") {
      changed = addBindingOrigin(element.name, "createRequire", authority) || changed;
    } else if (sourceKind === "commonJsModule" && propertyName === "require") {
      changed = addBindingOrigin(element.name, "require", authority) || changed;
    }
  }
  return changed;
}

function addBindingOrigin(identifier, kind, authority) {
  const symbol = authority.checker.getSymbolAtLocation(identifier);
  if (!symbol) throw new Error(`Activation inventory could not bind loader identifier ${identifier.text}.`);
  const previous = authority.origins.get(symbol);
  if (previous && previous !== kind) {
    throw new Error(`Activation inventory loader binding ${identifier.text} has conflicting origins.`);
  }
  if (previous === kind) return false;
  authority.origins.set(symbol, kind);
  for (const declaration of authority.dependents.get(symbol) ?? []) {
    enqueueLoaderDeclaration(declaration, authority);
  }
  return true;
}

function bindingPropertyName(element) {
  const property = element.propertyName;
  return property && (ts.isIdentifier(property) || ts.isStringLiteral(property)) ? property.text : element.name.text;
}

function isNodeModuleRequireCall(expression, authority) {
  if (!ts.isCallExpression(expression) || loaderCallKind(expression, authority) !== "require") return false;
  const argument = expression.arguments[0];
  return (
    expression.arguments.length === 1 &&
    argument !== undefined &&
    ts.isStringLiteral(argument) &&
    /^(?:node:)?module$/u.test(argument.text)
  );
}

function isCreateRequireCall(call, authority) {
  return loaderExpressionOrigin(call.expression, authority) === "createRequire";
}

function wrapperLoaderCall(initializer, authority) {
  const expression = unwrapExpression(initializer);
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined;
  return callableWrapper(expression.parameters, expression.body, authority);
}

function functionLoaderCall(declaration, authority) {
  if (!declaration.body) return undefined;
  return callableWrapper(declaration.parameters, declaration.body, authority);
}

function callableWrapper(parameters, body, authority) {
  if (parameters.length !== 1 || !ts.isIdentifier(parameters[0].name)) return undefined;
  let expression;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1 || !ts.isReturnStatement(body.statements[0])) return undefined;
    expression = body.statements[0].expression;
  } else {
    expression = body;
  }
  if (!expression) return undefined;
  expression = unwrapExpression(expression);
  if (!ts.isCallExpression(expression) || expression.arguments.length !== 1) return undefined;
  const argument = unwrapExpression(expression.arguments[0]);
  if (
    !ts.isIdentifier(argument) ||
    authority.checker.getSymbolAtLocation(argument) !== authority.checker.getSymbolAtLocation(parameters[0].name)
  ) {
    return undefined;
  }
  const kind = loaderCallKind(expression, authority);
  return kind ? { kind, call: expression } : undefined;
}

function loaderCallKind(call, authority) {
  const origin = loaderExpressionOrigin(call.expression, authority);
  return origin === "import" || origin === "require" ? origin : undefined;
}

function loaderExpressionOrigin(expression, authority) {
  const value = unwrapExpression(expression);
  if (value.kind === ts.SyntaxKind.ImportKeyword) return "import";
  if (ts.isIdentifier(value)) return identifierLoaderOrigin(value, authority);
  if (isGlobalModuleRequireExpression(value, authority.checker)) return "require";
  const namespace = createRequireNamespaceForMember(value, authority);
  return namespace ? "createRequire" : undefined;
}

function identifierLoaderOrigin(identifier, authority) {
  const symbol = authority.checker.getSymbolAtLocation(identifier);
  if (symbol) return authority.origins.get(symbol);
  return identifier.text === "require" && isIdentifierExpressionReference(identifier) ? "require" : undefined;
}

function isIdentifierExpressionReference(identifier) {
  const parent = identifier.parent;
  return !(
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
    (ts.isImportSpecifier(parent) && parent.propertyName === identifier)
  );
}

function isGlobalModuleIdentifier(expression, checker) {
  const value = unwrapExpression(expression);
  return ts.isIdentifier(value) && value.text === "module" && checker.getSymbolAtLocation(value) === undefined;
}

function isGlobalModuleRequireExpression(expression, checker) {
  const value = unwrapExpression(expression);
  if (ts.isPropertyAccessExpression(value)) {
    return value.name.text === "require" && isGlobalModuleIdentifier(value.expression, checker);
  }
  return (
    ts.isElementAccessExpression(value) &&
    value.argumentExpression !== undefined &&
    ts.isStringLiteral(value.argumentExpression) &&
    value.argumentExpression.text === "require" &&
    isGlobalModuleIdentifier(value.expression, checker)
  );
}

function createRequireNamespaceForMember(expression, authority) {
  const value = unwrapExpression(expression);
  let owner;
  if (ts.isPropertyAccessExpression(value) && value.name.text === "createRequire") owner = value.expression;
  else if (
    ts.isElementAccessExpression(value) &&
    value.argumentExpression !== undefined &&
    ts.isStringLiteral(value.argumentExpression) &&
    value.argumentExpression.text === "createRequire"
  ) {
    owner = value.expression;
  }
  if (!owner) return undefined;
  const namespace = unwrapExpression(owner);
  if (isNodeModuleRequireCall(namespace, authority)) return namespace;
  if (!ts.isIdentifier(namespace)) return undefined;
  const symbol = authority.checker.getSymbolAtLocation(namespace);
  return symbol && authority.origins.get(symbol) === "createRequireNamespace" ? namespace : undefined;
}

function createRequireMemberExpression(namespaceExpression, authority) {
  const namespace = outerWrappedExpression(namespaceExpression);
  const parent = namespace.parent;
  return createRequireNamespaceForMember(parent, authority) === namespaceExpression
    ? outerWrappedExpression(parent)
    : undefined;
}

function isDestructuringLoaderAssignment(node, authority) {
  if (
    !ts.isBinaryExpression(node) ||
    node.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isObjectLiteralExpression(unwrapExpression(node.left))
  ) {
    return false;
  }
  const source = unwrapExpression(node.right);
  const sourceKind = isGlobalModuleIdentifier(source, authority.checker)
    ? "commonJsModule"
    : loaderExpressionOrigin(source, authority);
  if (sourceKind !== "commonJsModule" && sourceKind !== "createRequireNamespace") return false;
  return unwrapExpression(node.left).properties.some((property) => {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return false;
    const name = propertyNameText(property.name);
    return (
      (sourceKind === "commonJsModule" && name === "require") ||
      (sourceKind === "createRequireNamespace" && name === "createRequire")
    );
  });
}

function propertyNameText(name) {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function unwrapExpression(expression) {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function freezeClassifications(classifications) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(classifications).map(([edge, triggers]) => [
        edge,
        Object.freeze({ occurrences: 1, triggers: Object.freeze([...triggers]) })
      ])
    )
  );
}

function defineActivationTriggerContract(contract) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(contract).map(([trigger, entry]) => [
        trigger,
        Object.freeze({
          events: Object.freeze([...entry.events]),
          roots: Object.freeze([...entry.roots]),
          maximumModules: entry.maximumModules,
          maximumBytes: entry.maximumBytes,
          forbidden: Object.freeze([...entry.forbidden])
        })
      ])
    )
  );
}

function classifyActivationEvents(groups) {
  const classifications = {};
  for (const [trigger, events] of Object.entries(groups)) {
    for (const event of events) {
      if (classifications[event] !== undefined) throw new Error(`Activation event classified twice: ${event}`);
      classifications[event] = trigger;
    }
  }
  return Object.freeze(classifications);
}

async function resolveTypescriptImport(repositoryRoot, importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const extension = path.extname(raw);
  const candidates =
    extension === ".mjs"
      ? [raw.replace(/\.mjs$/u, ".mts"), raw]
      : extension === ".cjs"
        ? [raw.replace(/\.cjs$/u, ".cts"), raw]
        : extension === ".js"
          ? [
              raw.replace(/\.js$/u, ".ts"),
              raw.replace(/\.js$/u, ".tsx"),
              raw.replace(/\.js$/u, ".mts"),
              raw.replace(/\.js$/u, ".cts"),
              raw
            ]
          : extension
            ? [raw]
            : [
                `${raw}.ts`,
                `${raw}.tsx`,
                `${raw}.mts`,
                `${raw}.cts`,
                path.join(raw, "index.ts"),
                path.join(raw, "index.tsx"),
                path.join(raw, "index.mts"),
                path.join(raw, "index.cts")
              ];
  for (const candidate of candidates) {
    assertContained(repositoryRoot, candidate);
    try {
      const candidateStat = await lstat(candidate, { bigint: true });
      if (candidateStat.isSymbolicLink()) {
        throw new Error(`Activation inventory import resolved through a symlink: ${candidate}`);
      }
      if (candidateStat.isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
}

function boundedAggregateBudget(maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > maximumAggregateSourceBytes) {
    throw new Error(`Activation inventory aggregate byte bound is invalid: ${maximum}`);
  }
  return { maximum, used: 0 };
}

function boundedUpperLimit(value, maximum, label, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw new Error(`Activation inventory ${label} bound is invalid: ${value}`);
  }
  return value;
}

function reserveAggregateBytes(budget, bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maximumSourceBytes) {
    throw new Error(`Activation inventory per-file byte bound is invalid: ${bytes}`);
  }
  if (budget.used + bytes > budget.maximum) {
    throw new Error(`Activation inventory exceeds its ${budget.maximum}-byte aggregate source bound.`);
  }
  budget.used += bytes;
}

function assertBoundedRead(budget, fileBytes, offset, length) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    offset + length > fileBytes ||
    fileBytes > maximumSourceBytes ||
    budget.used > budget.maximum
  ) {
    throw new Error("Activation inventory attempted an unbounded source read.");
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameFileVersion(left, right) {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function canonicalContainedPath(repositoryRoot, file) {
  const lexicalRoot = path.resolve(repositoryRoot);
  const lexicalFile = path.resolve(file);
  assertContained(lexicalRoot, lexicalFile);
  const [canonicalRoot, canonicalFile] = await Promise.all([realpath(lexicalRoot), realpath(lexicalFile)]);
  assertContained(canonicalRoot, canonicalFile);
  const expectedCanonicalFile = path.resolve(canonicalRoot, path.relative(lexicalRoot, lexicalFile));
  if (canonicalFile !== expectedCanonicalFile) {
    throw new Error(`Activation inventory source resolved through a symlinked path: ${file}`);
  }
  return { root: canonicalRoot, file: canonicalFile };
}

function matchesOwnerNeedle(file, needle) {
  const extensionRelative = file.startsWith("src/extension/") ? file.slice("src/extension/".length) : file;
  return needle.endsWith("/") ? extensionRelative.startsWith(needle) : extensionRelative === needle;
}

function assertContained(repositoryRoot, file) {
  const relative = path.relative(repositoryRoot, file);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Source escaped repository root: ${file}`);
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

async function main() {
  const report = await measureActivationTriggers();
  const failures = activationBudgetFailures(report);
  process.stdout.write(`${JSON.stringify({ ...report, budgets: activationTriggerBudgets, failures }, null, 2)}\n`);
  if (failures.length > 0) process.exitCode = 1;
}

async function activationMeasurementChildMain() {
  const repositoryRoot = process.argv[3];
  const synchronousRegistrationDelayMs = Number(process.argv[4]);
  if (
    !repositoryRoot ||
    !Number.isSafeInteger(synchronousRegistrationDelayMs) ||
    synchronousRegistrationDelayMs < 0 ||
    synchronousRegistrationDelayMs > maximumDependencyFreeActivationMs + 1
  ) {
    throw new Error("Dependency-free activation child received invalid bounded arguments.");
  }
  const measurement = await measureDependencyFreeActivationInProcess(repositoryRoot, synchronousRegistrationDelayMs);
  process.stdout.write(JSON.stringify(measurement));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === activationMeasurementChildFlag) await activationMeasurementChildMain();
  else await main();
}
