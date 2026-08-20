import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, "..");
const maximumSourceBytes = 2 * 1024 * 1024;
const maximumProductionSourceFiles = 2_048;

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
    const files = await transitiveRuntimeSources(root, budget.roots);
    const relativeFiles = [...files].map((file) => toPosix(path.relative(root, file))).sort();
    let bytes = 0;
    for (const file of files) bytes += (await stat(file)).size;
    measurements[trigger] = {
      modules: files.size,
      bytes,
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
  for (const file of sourceFiles) {
    const source = await readBoundedRegularFile(repositoryRoot, file);
    const relativeFile = toPosix(path.relative(repositoryRoot, file));
    for (const edge of runtimeCallEdges(source)) {
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
  const manifest = JSON.parse(await readBoundedRegularFile(repositoryRoot, packageFile));
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

async function transitiveRuntimeSources(repositoryRoot, roots) {
  const pending = roots.map((root) => path.resolve(repositoryRoot, root));
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (visited.has(file)) continue;
    assertContained(repositoryRoot, file);
    const sourceStat = await stat(file);
    if (!sourceStat.isFile() || sourceStat.size > maximumSourceBytes) {
      throw new Error(`Activation budget source is not a bounded regular file: ${file}`);
    }
    const source = await readFile(file, "utf8");
    visited.add(file);
    for (const specifier of staticRuntimeSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = await resolveTypescriptImport(file, specifier);
      if (resolved) pending.push(resolved);
    }
  }
  return visited;
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

async function readBoundedRegularFile(repositoryRoot, file) {
  assertContained(repositoryRoot, file);
  const sourceStat = await lstat(file);
  if (!sourceStat.isFile() || sourceStat.size > maximumSourceBytes) {
    throw new Error(`Activation inventory source is not a bounded regular file: ${file}`);
  }
  return readFile(file, "utf8");
}

function runtimeCallEdges(source) {
  const normalized = withoutComments(source);
  const edges = [];
  const importAliases = new Set();
  const requireAliases = new Set(["require"]);
  const createRequireAliases = createRequireBindings(normalized);
  const wrapperCalls = new Set();
  const wrapperPattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*(import|require)\s*\(\s*\2\s*\)/gu;
  for (const match of normalized.matchAll(wrapperPattern)) {
    (match[3] === "import" ? importAliases : requireAliases).add(match[1]);
    wrapperCalls.add(match.index + match[0].lastIndexOf(match[3]));
  }
  const functionWrapperPattern =
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+(import|require)\s*\(\s*\2\s*\)\s*;?\s*\}/gu;
  for (const match of normalized.matchAll(functionWrapperPattern)) {
    (match[3] === "import" ? importAliases : requireAliases).add(match[1]);
    wrapperCalls.add(match.index + match[0].lastIndexOf(match[3]));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of normalized.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;?/gu
    )) {
      if (importAliases.has(match[2]) && !importAliases.has(match[1])) {
        importAliases.add(match[1]);
        changed = true;
      }
      if (requireAliases.has(match[2]) && !requireAliases.has(match[1])) {
        requireAliases.add(match[1]);
        changed = true;
      }
      if (createRequireAliases.has(match[2]) && !createRequireAliases.has(match[1])) {
        createRequireAliases.add(match[1]);
        changed = true;
      }
    }
    for (const match of normalized.matchAll(
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*\([^;\n]{0,512}\)\s*;?/gu
    )) {
      if (createRequireAliases.has(match[2]) && !requireAliases.has(match[1])) {
        requireAliases.add(match[1]);
        changed = true;
      }
    }
  }
  const loaderNames = ["import", ...importAliases, ...requireAliases].sort(
    (left, right) => right.length - left.length || left.localeCompare(right)
  );
  const callPattern = new RegExp(`\\b(${loaderNames.map(regexpEscape).join("|")})\\s*\\(\\s*([^)]{0,512})\\)`, "gu");
  for (const match of normalized.matchAll(callPattern)) {
    if (wrapperCalls.has(match.index)) continue;
    const kind = match[1] === "import" || importAliases.has(match[1]) ? "import" : "require";
    if (kind === "require" && !requireAliases.has(match[1])) continue;
    const prefix = normalized.slice(Math.max(0, match.index - 64), match.index);
    if (match[1] === "import" && /\btypeof\s*$/u.test(prefix)) continue;
    const literal = /^(["'])([^"'\\]+)\1\s*$/u.exec(match[2]);
    edges.push({ kind, specifier: literal?.[2] ?? "<non-literal>" });
  }
  return edges;
}

function regexpEscape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function createRequireBindings(source) {
  const bindings = new Set();
  const importPattern = /\bimport\s*\{([^}]{0,512})\}\s*from\s*["'](?:node:)?module["']/gu;
  for (const match of source.matchAll(importPattern)) {
    for (const binding of match[1].split(",")) {
      const createRequire = /^\s*createRequire(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/u.exec(binding);
      if (createRequire) bindings.add(createRequire[1] ?? "createRequire");
    }
  }
  const destructurePattern =
    /\b(?:const|let|var)\s*\{\s*createRequire(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*\}\s*=\s*require\s*\(\s*["'](?:node:)?module["']\s*\)/gu;
  for (const match of source.matchAll(destructurePattern)) bindings.add(match[1] ?? "createRequire");
  return bindings;
}

function withoutComments(source) {
  let result = "";
  let index = 0;
  let state = "code";
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "code" && current === "/" && next === "/") {
      result += "  ";
      index += 2;
      state = "line-comment";
      continue;
    }
    if (state === "code" && current === "/" && next === "*") {
      result += "  ";
      index += 2;
      state = "block-comment";
      continue;
    }
    if (state === "line-comment") {
      result += current === "\n" ? "\n" : " ";
      index += 1;
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 2;
        state = "code";
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (state === "code" && (current === '"' || current === "'" || current === "`")) state = current;
    else if (state !== "code" && current === "\\") {
      result += current + (next ?? "");
      index += next === undefined ? 1 : 2;
      continue;
    } else if (state !== "code" && current === state) state = "code";
    result += current;
    index += 1;
  }
  return result;
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

function staticRuntimeSpecifiers(source) {
  source = withoutComments(source);
  const specifiers = [];
  const importPattern = /(^|\n)\s*import\s+(?!type\b)(?:(?!\n\s*import\b)[\s\S])*?\bfrom\s*["']([^"']+)["']\s*;?/gu;
  const sideEffectPattern = /(^|\n)\s*import\s*["']([^"']+)["']\s*;?/gu;
  const exportPattern = /(^|\n)\s*export\s+(?!type\b)(?:(?!\n\s*export\b)[\s\S])*?\bfrom\s*["']([^"']+)["']\s*;?/gu;
  for (const pattern of [importPattern, sideEffectPattern, exportPattern]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[2]);
  }
  return specifiers;
}

async function resolveTypescriptImport(importer, specifier) {
  const raw = path.resolve(path.dirname(importer), specifier);
  const candidates = path.extname(raw)
    ? [raw.replace(/\.js$/u, ".ts"), raw.replace(/\.js$/u, ".tsx"), raw]
    : [`${raw}.ts`, `${raw}.tsx`, path.join(raw, "index.ts")];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return undefined;
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
