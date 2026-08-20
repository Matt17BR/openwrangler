import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const maximumSourceBytes = 2 * 1024 * 1024;
const maximumAggregateSourceBytes = 16 * 1024 * 1024;
const maximumProductionSourceFiles = 2_048;
const maximumSyntaxNodes = 250_000;

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
    const discovery = await discoverTransitiveRuntimeSources(root, budget.roots);
    const relativeFiles = [...discovery.files].map((file) => toPosix(path.relative(root, file))).sort();
    measurements[trigger] = {
      modules: discovery.files.size,
      bytes: discovery.bytes,
      files: relativeFiles,
      forbiddenMatches: budget.forbidden.flatMap((needle) =>
        relativeFiles.filter((file) => matchesOwnerNeedle(file, needle)).map((file) => ({ needle, file }))
      )
    };
  }
  const { dynamicEdges, activationEvents } = await measureActivationInventory(root);
  return {
    metric: "transitive-static-typescript-source-load-surface",
    repositoryRoot: root,
    measurements,
    dynamicEdges,
    activationEvents
  };
}

export async function measureActivationInventory(repositoryRoot = defaultRepositoryRoot) {
  const root = path.resolve(repositoryRoot);
  return {
    dynamicEdges: await measureDynamicEdges(root),
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
    for (const trigger of report.activationEvents.unknownTriggerClasses) {
      failures.push(`activation event: unknown trigger class ${trigger}`);
    }
  }
  return failures;
}

async function measureDynamicEdges(repositoryRoot) {
  const sourceRoot = path.resolve(repositoryRoot, "src/extension");
  const sourceFiles = await productionTypescriptSources(repositoryRoot, sourceRoot);
  const occurrenceCounts = new Map();
  const aggregateBudget = boundedAggregateBudget(maximumAggregateSourceBytes);
  for (const file of sourceFiles) {
    const { source } = await readBoundedRegularFile(repositoryRoot, file, aggregateBudget);
    const relativeFile = toPosix(path.relative(repositoryRoot, file));
    for (const edge of syntaxRuntimeInventory(source, file).dynamicEdges) {
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
  const contributedCommands = manifest.contributes?.commands;
  if (
    !Array.isArray(contributedCommands) ||
    !contributedCommands.every(
      (contribution) =>
        contribution !== null &&
        typeof contribution === "object" &&
        typeof contribution.command === "string" &&
        contribution.command.length > 0 &&
        contribution.command.length <= 512
    )
  ) {
    throw new Error("package.json contributes.commands must be a bounded command-object array.");
  }
  const contributed = contributedCommands.map(({ command }) => command).sort();
  const contributionDerived = contributed.map((command) => `onCommand:${command}`);
  const discovered = [...new Set([...explicit, ...contributionDerived])].sort();
  const classified = Object.keys(activationEventClassifications).sort();
  const discoveredSet = new Set(discovered);
  const occurrenceCounts = new Map();
  for (const event of explicit) occurrenceCounts.set(event, (occurrenceCounts.get(event) ?? 0) + 1);
  const contributedCommandCounts = new Map();
  for (const command of contributed) {
    contributedCommandCounts.set(command, (contributedCommandCounts.get(command) ?? 0) + 1);
  }
  const unclassified = discovered.filter((event) => activationEventClassifications[event] === undefined);
  const staleClassifications = classified.filter((event) => !discoveredSet.has(event));
  const occurrenceMismatches = [...occurrenceCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([event, actual]) => ({ event, actual }));
  const contributedCommandOccurrenceMismatches = [...contributedCommandCounts]
    .filter(([, occurrences]) => occurrences !== 1)
    .map(([command, actual]) => ({ command, actual }));
  const knownTriggerClasses = new Set(Object.keys(activationTriggerBudgets));
  const unknownTriggerClasses = [...new Set(Object.values(activationEventClassifications))]
    .filter((trigger) => !knownTriggerClasses.has(trigger))
    .sort();
  return {
    explicit,
    contributedCommands: contributed,
    contributionDerived,
    discovered,
    classified,
    unclassified,
    staleClassifications,
    occurrenceMismatches,
    contributedCommandOccurrenceMismatches,
    unknownTriggerClasses
  };
}

async function discoverTransitiveRuntimeSources(
  repositoryRoot,
  roots,
  { maximumAggregateBytes = maximumAggregateSourceBytes, beforeDescriptorOpen } = {}
) {
  const pending = roots.map((root) => path.resolve(repositoryRoot, root));
  const visited = new Set();
  const aggregateBudget = boundedAggregateBudget(maximumAggregateBytes);
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    const { source } = await readBoundedRegularFile(repositoryRoot, file, aggregateBudget, {
      beforeDescriptorOpen
    });
    visited.add(file);
    for (const specifier of syntaxRuntimeInventory(source, file).staticSpecifiers) {
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveTypescriptImport(repositoryRoot, file, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return { files: visited, bytes: aggregateBudget.used };
}

async function productionTypescriptSources(repositoryRoot, sourceRoot) {
  assertContained(repositoryRoot, sourceRoot);
  const pending = [sourceRoot];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      assertContained(repositoryRoot, candidate);
      if (entry.isSymbolicLink()) throw new Error(`Production source inventory encountered a symlink: ${candidate}`);
      if (entry.isDirectory()) {
        pending.push(candidate);
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
  { beforeDescriptorOpen } = {}
) {
  assertContained(repositoryRoot, file);
  const canonicalBefore = await canonicalContainedPath(repositoryRoot, file);
  const rootStat = await lstat(canonicalBefore.root, { bigint: true });
  if (!rootStat.isDirectory())
    throw new Error(`Activation inventory repository root is not a directory: ${repositoryRoot}`);
  const sourceStat = await lstat(file, { bigint: true });
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || sourceStat.size > BigInt(maximumSourceBytes)) {
    throw new Error(`Activation inventory source is not a bounded regular file: ${file}`);
  }
  await beforeDescriptorOpen?.(file);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(file, fsConstants.O_RDONLY | noFollow);
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
      descriptorStat.size > BigInt(maximumSourceBytes) ||
      !sameFileIdentity(sourceStat, descriptorStat) ||
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
    const [descriptorAfter, pathAfter, canonicalAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(file, { bigint: true }),
      canonicalContainedPath(repositoryRoot, file)
    ]);
    const rootAfter = await lstat(canonicalAfter.root, { bigint: true });
    if (
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(descriptorStat, descriptorAfter) ||
      !sameFileIdentity(descriptorAfter, pathAfter) ||
      !sameFileIdentity(rootStat, rootAfter) ||
      canonicalAfter.root !== canonicalBefore.root ||
      canonicalAfter.file !== canonicalBefore.file ||
      descriptorAfter.size !== descriptorStat.size ||
      pathAfter.size !== descriptorStat.size
    ) {
      throw new Error(`Activation inventory source changed identity during read: ${file}`);
    }
    return { source: content.toString("utf8"), bytes: size };
  } finally {
    await handle.close();
  }
}

function syntaxRuntimeInventory(source, file) {
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
  let syntaxNodes = 0;
  const visit = (node) => {
    syntaxNodes += 1;
    if (syntaxNodes > maximumSyntaxNodes) {
      throw new Error(`Activation inventory source exceeds ${maximumSyntaxNodes} syntax nodes: ${file}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (importDeclarationLoadsAtRuntime(node)) staticSpecifiers.push(node.moduleSpecifier.text);
      collectCreateRequireImport(node, createRequireAliases);
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
      changed = collectCommonJsCreateRequire(declaration, requireAliases, createRequireAliases) || changed;
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const localName = declaration.name.text;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isIdentifier(initializer)) {
        changed =
          copyLoaderAlias(localName, initializer.text, importAliases, requireAliases, createRequireAliases) || changed;
      }
      const wrapper = wrapperLoaderCall(declaration.initializer, importAliases, requireAliases);
      if (wrapper) {
        changed = addLoaderAlias(localName, wrapper.kind, importAliases, requireAliases) || changed;
        wrapperCalls.add(wrapper.call);
      }
      if (ts.isCallExpression(initializer)) {
        const callee = identifierName(initializer.expression);
        if (callee && createRequireAliases.has(callee) && !requireAliases.has(localName)) {
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

function scriptKind(file) {
  return /\.tsx$/u.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
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

function collectCreateRequireImport(declaration, aliases) {
  if (
    !ts.isStringLiteral(declaration.moduleSpecifier) ||
    !/^(?:node:)?module$/u.test(declaration.moduleSpecifier.text) ||
    !declaration.importClause?.namedBindings ||
    !ts.isNamedImports(declaration.importClause.namedBindings)
  ) {
    return;
  }
  for (const element of declaration.importClause.namedBindings.elements) {
    if ((element.propertyName?.text ?? element.name.text) === "createRequire" && !element.isTypeOnly) {
      aliases.add(element.name.text);
    }
  }
}

function collectCommonJsCreateRequire(declaration, requireAliases, createRequireAliases) {
  if (!ts.isObjectBindingPattern(declaration.name) || !declaration.initializer) return false;
  const initializer = unwrapExpression(declaration.initializer);
  if (!ts.isCallExpression(initializer) || loaderCallKind(initializer, new Set(), requireAliases) !== "require") {
    return false;
  }
  const argument = initializer.arguments[0];
  if (initializer.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) return false;
  if (!/^(?:node:)?module$/u.test(argument.text)) return false;
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

function copyLoaderAlias(localName, sourceName, importAliases, requireAliases, createRequireAliases) {
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
  return changed;
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

function identifierName(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) ? unwrapped.text : undefined;
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
  const candidates = path.extname(raw)
    ? [raw.replace(/\.js$/u, ".ts"), raw.replace(/\.js$/u, ".tsx"), raw]
    : [`${raw}.ts`, `${raw}.tsx`, path.join(raw, "index.ts")];
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
