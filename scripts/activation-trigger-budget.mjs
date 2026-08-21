import { constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
export const maximumDependencyFreeActivationMs = 2_000;

export const activationTriggerBudgets = Object.freeze({
  unrelated: {
    roots: ["src/extension/activate.ts"],
    maximumModules: 3,
    maximumBytes: 48 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  utility: {
    roots: ["src/extension/activate.ts"],
    maximumModules: 3,
    maximumBytes: 48 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "notebook-preview": {
    roots: ["src/extension/activate.ts", "src/extension/notebooks/notebookPreviewCoordinator.ts"],
    maximumModules: 24,
    maximumBytes: 320 * 1024,
    forbidden: ["pythonBridge.ts", "r/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  notebook: {
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
    roots: ["src/extension/activate.ts", "src/extension/pythonBridge.ts", "src/extension/runtimeCommands.ts"],
    maximumModules: 36,
    maximumBytes: 512 * 1024,
    forbidden: ["r/", "notebooks/", "files/fileOpen.ts", "nativeViews.ts"]
  },
  "trusted-pickle": {
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
    roots: ["src/extension/activate.ts", "src/extension/sessionCoordinator.ts", "src/extension/nativeViews.ts"],
    maximumModules: 96,
    maximumBytes: 1700 * 1024,
    forbidden: ["pythonBridge.ts", "files/fileOpen.ts", "notebooks/pythonInteractiveCommands.ts"]
  },
  "native-live": {
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
  }
});

export const dynamicEdgeClassifications = freezeClassifications({
  "src/extension/lazyActivationOwners.ts|require|./notebooks/notebookPreviewCoordinator": ["notebook-preview"],
  "src/extension/lazyActivationOwners.ts|import|./sessionCoordinator.js": [
    "notebook",
    "r",
    "r-document",
    "custom-editor",
    "native-view",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./pythonBridge.js": [
    "runtime",
    "trusted-pickle",
    "custom-editor",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./files/fileOpen.js": ["custom-editor", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./files/trustedPickleConversion.js": ["trusted-pickle", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./files/trustedPickleWorker.js": ["trusted-pickle", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./notebooks/pythonInteractiveCommands.js": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./notebooks/jupyterBridge.js": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./notebooks/notebookCellResult.js": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./notebooks/rendererMessaging.js": [
    "notebook",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./r/rInteractiveCommands.js": [
    "r",
    "r-document",
    "native-live",
    "test-api"
  ],
  "src/extension/lazyActivationOwners.ts|import|./r/rDocumentCommands.js": ["r-document", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./runtimeCommands.js": ["runtime", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./nativeViews.js": ["native-view", "native-live", "test-api"],
  "src/extension/lazyActivationOwners.ts|import|./webviewPanel.js": ["test-api"]
});

export const activationEventClassifications = classifyActivationEvents({
  "custom-editor": [
    "onCommand:openWrangler.openFile",
    "onCommand:openWrangler.changeImportOptions",
    "onCommand:openWrangler.openPath",
    "onCustomEditor:openWrangler.viewer"
  ],
  "trusted-pickle": ["onCommand:openWrangler.convertTrustedPickle"],
  notebook: [
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
  r: [
    "onCommand:openWrangler.openRDataframe",
    "onCommand:openWrangler.openRInteractiveVariable",
    "onCommand:openWrangler.refreshRInteractiveVariables",
    "onCommand:openWrangler.openCachedRInteractiveVariable"
  ],
  "r-document": ["onCommand:openWrangler.runRDocument"],
  "notebook-preview": ["onCommand:openWrangler.chooseNotebookPreviewProvider"],
  runtime: [
    "onCommand:openWrangler.changeRuntime",
    "onCommand:openWrangler.clearRuntime",
    "onCommand:openWrangler.installRuntimeDependencies",
    "onCommand:openWrangler.revalidateRuntimeDependencies"
  ],
  "native-view": [
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
  "native-live": ["onCommand:openWrangler.refreshLiveDataframes", "onView:openWrangler.operations"],
  utility: [
    "onCommand:openWrangler.openWalkthrough",
    "onCommand:openWrangler.openSettings",
    "onCommand:openWrangler.reportIssue"
  ]
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
  const aggregateBudget = boundedAggregateBudget(maximumAggregateSourceBytes);
  const [activateSource, ownersSource] = await Promise.all([
    readBoundedRegularFile(root, path.resolve(root, "src/extension/activate.ts"), aggregateBudget),
    readBoundedRegularFile(root, path.resolve(root, "src/extension/lazyActivationOwners.ts"), aggregateBudget)
  ]);
  let virtualElapsedMs = 0;
  let delayInjected = false;
  const clock = synchronousRegistrationDelayMs === 0 ? globalThis.performance : { now: () => virtualElapsedMs };
  const disposable = () => ({ dispose: () => undefined });
  const register = () => {
    if (!delayInjected) {
      delayInjected = true;
      virtualElapsedMs += synchronousRegistrationDelayMs;
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
      onDidOpenNotebookDocument: register,
      onDidGrantWorkspaceTrust: register
    },
    Uri: { parse: (value) => value },
    version: "activation-budget"
  };
  const sandbox = {
    AggregateError,
    console,
    performance: clock,
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
  const startedAt = clock.now();
  let failure;
  let elapsedMs;
  try {
    const activated = activation.activate(context);
    elapsedMs = Math.max(0, clock.now() - startedAt);
    await activated;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await activation.deactivate();
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    }
  }
  elapsedMs ??= Math.max(0, clock.now() - startedAt);
  const declaredMaximumMs = activation.MAX_SYNCHRONOUS_ACTIVATION_MS;
  if (declaredMaximumMs !== maximumDependencyFreeActivationMs) {
    failure = `Activation declares ${String(declaredMaximumMs)} ms instead of ${maximumDependencyFreeActivationMs} ms.`;
  }
  return {
    elapsedMs,
    maximumMs: maximumDependencyFreeActivationMs,
    withinBudget: failure === undefined && elapsedMs <= maximumDependencyFreeActivationMs,
    ...(failure === undefined ? {} : { failure })
  };
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
  const knownTriggerClasses = new Set([...Object.keys(activationTriggerBudgets), "test-api"]);
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
    beforeDescriptorOpen,
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
      beforeDescriptorOpen,
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
  { beforeDescriptorOpen, afterDescriptorRead } = {}
) {
  assertContained(repositoryRoot, file);
  const canonicalBefore = await canonicalContainedPath(repositoryRoot, file);
  const rootStat = await lstat(canonicalBefore.root, { bigint: true });
  if (!rootStat.isDirectory())
    throw new Error(`Activation inventory repository root is not a directory: ${repositoryRoot}`);
  const sourceStat = await lstat(file, { bigint: true });
  if (
    sourceStat.isSymbolicLink() ||
    !sourceStat.isFile() ||
    sourceStat.nlink !== 1n ||
    sourceStat.size > BigInt(maximumSourceBytes)
  ) {
    throw new Error(`Activation inventory source is not a bounded regular file: ${file}`);
  }
  await beforeDescriptorOpen?.(file);
  const canonicalBeforeOpen = await canonicalContainedPath(repositoryRoot, file);
  const [pathBeforeOpen, rootBeforeOpen] = await Promise.all([
    lstat(file, { bigint: true }),
    lstat(canonicalBeforeOpen.root, { bigint: true })
  ]);
  if (
    pathBeforeOpen.isSymbolicLink() ||
    !pathBeforeOpen.isFile() ||
    pathBeforeOpen.nlink !== 1n ||
    !sameFileVersion(sourceStat, pathBeforeOpen) ||
    !sameFileIdentity(rootStat, rootBeforeOpen) ||
    canonicalBeforeOpen.root !== canonicalBefore.root ||
    canonicalBeforeOpen.file !== canonicalBefore.file
  ) {
    throw new Error(`Activation inventory source changed identity before read: ${file}`);
  }
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
    const descriptorStat = await handle.stat({ bigint: true });
    const canonicalAtOpen = await canonicalContainedPath(repositoryRoot, file);
    const rootAtOpen = await lstat(canonicalAtOpen.root, { bigint: true });
    if (
      !descriptorStat.isFile() ||
      descriptorStat.nlink !== 1n ||
      descriptorStat.size > BigInt(maximumSourceBytes) ||
      !sameFileVersion(sourceStat, descriptorStat) ||
      !sameFileIdentity(rootStat, rootAtOpen) ||
      canonicalAtOpen.root !== canonicalBefore.root ||
      canonicalAtOpen.file !== canonicalBefore.file
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
      pathAfter.isSymbolicLink() ||
      descriptorAfter.nlink !== 1n ||
      pathAfter.nlink !== 1n ||
      !sameFileVersion(descriptorStat, descriptorAfter) ||
      !sameFileVersion(descriptorAfter, pathAfter) ||
      !sameFileIdentity(rootStat, rootAfter) ||
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
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, scriptKind(file));
  const parseDiagnostic = sourceFile.parseDiagnostics?.[0];
  if (parseDiagnostic) {
    throw new Error(`Activation inventory source has invalid TypeScript syntax (TS${parseDiagnostic.code}): ${file}`);
  }
  const variableDeclarations = [];
  const functionDeclarations = [];
  const callExpressions = [];
  const staticSpecifiers = [];
  const createRequireAliases = new Set();
  const createRequireNamespaces = new Set();
  let syntaxNodes = 0;
  const visit = (node) => {
    syntaxNodes += 1;
    if (syntaxNodes > maximumSyntaxNodes) {
      throw new Error(`Activation inventory source exceeds ${maximumSyntaxNodes} syntax nodes: ${file}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (importDeclarationLoadsAtRuntime(node)) staticSpecifiers.push(node.moduleSpecifier.text);
      collectCreateRequireImport(node, createRequireAliases, createRequireNamespaces);
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
    if (ts.isVariableDeclaration(node)) variableDeclarations.push(node);
    if (ts.isFunctionDeclaration(node)) functionDeclarations.push(node);
    if (ts.isCallExpression(node)) callExpressions.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const importAliases = new Set();
  const requireAliases = new Set(["require"]);
  const wrapperCalls = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of variableDeclarations) {
      changed =
        collectCommonJsCreateRequire(declaration, requireAliases, createRequireAliases, createRequireNamespaces) ||
        changed;
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const localName = declaration.name.text;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isIdentifier(initializer)) {
        changed =
          copyLoaderAlias(
            localName,
            initializer.text,
            importAliases,
            requireAliases,
            createRequireAliases,
            createRequireNamespaces
          ) || changed;
      }
      const wrapper = wrapperLoaderCall(declaration.initializer, importAliases, requireAliases);
      if (wrapper) {
        changed = addLoaderAlias(localName, wrapper.kind, importAliases, requireAliases) || changed;
        wrapperCalls.add(wrapper.call);
      }
      if (ts.isCallExpression(initializer)) {
        if (
          isCreateRequireCall(initializer, createRequireAliases, createRequireNamespaces) &&
          !requireAliases.has(localName)
        ) {
          requireAliases.add(localName);
          changed = true;
        }
      }
    }
    for (const declaration of functionDeclarations) {
      if (!declaration.name) continue;
      const wrapper = functionLoaderCall(declaration, importAliases, requireAliases);
      if (!wrapper) continue;
      changed = addLoaderAlias(declaration.name.text, wrapper.kind, importAliases, requireAliases) || changed;
      wrapperCalls.add(wrapper.call);
    }
  }

  const loaderEscapes = propertyLoaderEscapes(
    sourceFile,
    importAliases,
    requireAliases,
    createRequireAliases,
    createRequireNamespaces
  );
  if (loaderEscapes.length > 0) {
    throw new Error(
      `Activation inventory loader alias escapes through an object property (${loaderEscapes.join(", ")}): ${file}`
    );
  }

  const dynamicEdges = [];
  for (const call of callExpressions) {
    if (wrapperCalls.has(call)) continue;
    const kind = loaderCallKind(call, importAliases, requireAliases);
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

function propertyLoaderEscapes(
  sourceFile,
  importAliases,
  requireAliases,
  createRequireAliases,
  createRequireNamespaces
) {
  const escapes = [];
  const loaderKind = (expression) => {
    const value = unwrapExpression(expression);
    if (!ts.isIdentifier(value)) return undefined;
    if (importAliases.has(value.text)) return "import";
    if (requireAliases.has(value.text)) return "require";
    if (createRequireAliases.has(value.text)) return "createRequire";
    return createRequireNamespaces.has(value.text) ? "createRequireNamespace" : undefined;
  };
  const visit = (node) => {
    if (ts.isPropertyAssignment(node)) {
      const kind = loaderKind(node.initializer);
      if (kind) escapes.push(`${node.name.getText(sourceFile)}:${kind}`);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      const kind = loaderKind(node.name);
      if (kind) escapes.push(`${node.name.text}:${kind}`);
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      (ts.isPropertyAccessExpression(unwrapExpression(node.left)) ||
        ts.isElementAccessExpression(unwrapExpression(node.left)))
    ) {
      const kind = loaderKind(node.right);
      if (kind) escapes.push(`${node.left.getText(sourceFile)}:${kind}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return escapes;
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

function collectCreateRequireImport(declaration, aliases, namespaces) {
  if (
    !ts.isStringLiteral(declaration.moduleSpecifier) ||
    !/^(?:node:)?module$/u.test(declaration.moduleSpecifier.text) ||
    !declaration.importClause?.namedBindings
  ) {
    return;
  }
  const bindings = declaration.importClause.namedBindings;
  if (ts.isNamespaceImport(bindings)) {
    namespaces.add(bindings.name.text);
    return;
  }
  for (const element of bindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === "createRequire" && !element.isTypeOnly) {
      aliases.add(element.name.text);
    }
  }
}

function collectCommonJsCreateRequire(declaration, requireAliases, createRequireAliases, createRequireNamespaces) {
  if (!declaration.initializer) return false;
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isCallExpression(initializer) || loaderCallKind(initializer, new Set(), requireAliases) !== "require") {
    return false;
  }
  const argument = initializer.arguments[0];
  if (initializer.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) return false;
  if (!/^(?:node:)?module$/u.test(argument.text)) return false;
  if (ts.isIdentifier(declaration.name)) {
    if (createRequireNamespaces.has(declaration.name.text)) return false;
    createRequireNamespaces.add(declaration.name.text);
    return true;
  }
  if (!ts.isObjectBindingPattern(declaration.name)) return false;
  let changed = false;
  for (const element of declaration.name.elements) {
    if (!ts.isIdentifier(element.name)) continue;
    const importedName =
      element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName.text : element.name.text;
    if (importedName === "createRequire" && !createRequireAliases.has(element.name.text)) {
      createRequireAliases.add(element.name.text);
      changed = true;
    }
  }
  return changed;
}

function copyLoaderAlias(
  localName,
  sourceName,
  importAliases,
  requireAliases,
  createRequireAliases,
  createRequireNamespaces
) {
  let changed = false;
  if (importAliases.has(sourceName) && !importAliases.has(localName)) {
    importAliases.add(localName);
    changed = true;
  }
  if (requireAliases.has(sourceName) && !requireAliases.has(localName)) {
    requireAliases.add(localName);
    changed = true;
  }
  if (createRequireAliases.has(sourceName) && !createRequireAliases.has(localName)) {
    createRequireAliases.add(localName);
    changed = true;
  }
  if (createRequireNamespaces.has(sourceName) && !createRequireNamespaces.has(localName)) {
    createRequireNamespaces.add(localName);
    changed = true;
  }
  return changed;
}

function isCreateRequireCall(call, aliases, namespaces) {
  const callee = unwrapExpression(call.expression);
  if (ts.isIdentifier(callee)) return aliases.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "createRequire") return false;
  const namespace = unwrapExpression(callee.expression);
  return ts.isIdentifier(namespace) && namespaces.has(namespace.text);
}

function addLoaderAlias(localName, kind, importAliases, requireAliases) {
  const aliases = kind === "import" ? importAliases : requireAliases;
  if (aliases.has(localName)) return false;
  aliases.add(localName);
  return true;
}

function wrapperLoaderCall(initializer, importAliases, requireAliases) {
  const expression = unwrapExpression(initializer);
  if (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression)) return undefined;
  return callableWrapper(expression.parameters, expression.body, importAliases, requireAliases);
}

function functionLoaderCall(declaration, importAliases, requireAliases) {
  if (!declaration.body) return undefined;
  return callableWrapper(declaration.parameters, declaration.body, importAliases, requireAliases);
}

function callableWrapper(parameters, body, importAliases, requireAliases) {
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
  if (!ts.isIdentifier(argument) || argument.text !== parameters[0].name.text) return undefined;
  const kind = loaderCallKind(expression, importAliases, requireAliases);
  return kind ? { kind, call: expression } : undefined;
}

function loaderCallKind(call, importAliases, requireAliases) {
  const callee = unwrapExpression(call.expression);
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return "import";
  if (!ts.isIdentifier(callee)) return undefined;
  if (importAliases.has(callee.text)) return "import";
  return requireAliases.has(callee.text) ? "require" : undefined;
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
