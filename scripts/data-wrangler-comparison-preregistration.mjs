import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION } from "./data-wrangler-comparison-driver-contract.mjs";
import { DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS } from "./data-wrangler-comparison-inventory.mjs";
import { readBoundedDataWranglerComparisonSpecificationDraft } from "./generate-data-wrangler-comparison-spec.mjs";
import {
  canonicalStudyJson,
  captureDataWranglerStudyMethodReceipt,
  createDataWranglerStudySchedule,
  DATA_WRANGLER_STUDY_CELLS,
  DATA_WRANGLER_STUDY_DEADLINES_MS,
  DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS,
  DATA_WRANGLER_STUDY_METRICS,
  DATA_WRANGLER_STUDY_METHOD_PROTOCOL,
  DATA_WRANGLER_STUDY_SCHEDULE_SHA256,
  DATA_WRANGLER_STUDY_SEED,
  DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL,
  digestStudyValue
} from "./data-wrangler-comparison-study.mjs";
import {
  digestDurableJsonValue,
  publishDurableStudyJsonExclusive,
  recoverDurableStudyJsonPublication
} from "./durable-study-json.mjs";
import {
  digestLinuxStudySupervisorValue,
  LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY,
  LINUX_STUDY_SUPERVISOR_PROTOCOL
} from "./linux-study-supervisor-client.mjs";

export const DATA_WRANGLER_COMPARISON_PREREGISTRATION_PROTOCOL =
  "openwrangler-data-wrangler-comparison-preregistration-v2";
export const DATA_WRANGLER_COMPARISON_PREREGISTRATION_RECEIPT_PROTOCOL =
  "openwrangler-data-wrangler-comparison-preregistration-receipt-v2";
export const DATA_WRANGLER_COMPARISON_EXECUTION_GRAPH_PROTOCOL =
  "openwrangler-data-wrangler-comparison-execution-graph-v1";

const MAXIMUM_PREREGISTRATION_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PACKAGE_LOCK_PATH = resolve(REPOSITORY_ROOT, "package-lock.json");
const PACKAGE_JSON_PATH = resolve(REPOSITORY_ROOT, "package.json");
const DRIVER_PACKAGER_PATH = resolve(REPOSITORY_ROOT, "scripts/data-wrangler-comparison-driver.mjs");
const PREREGISTRATION_TOOL_PATH = fileURLToPath(import.meta.url);
const PREPARATION_TOOL_PATH = resolve(REPOSITORY_ROOT, "scripts/run-data-wrangler-comparison-preparation.mjs");
const ENVIRONMENT_CAPTURE_PATH = resolve(REPOSITORY_ROOT, "scripts/data-wrangler-comparison-environment.mjs");
const STUDY_RUNTIME_PATH = resolve(REPOSITORY_ROOT, "scripts/data-wrangler-comparison-study.mjs");
const DURABLE_PUBLISHER_PATH = resolve(REPOSITORY_ROOT, "scripts/durable-study-json.mjs");
const CACHE_HARNESS_PATH = resolve(REPOSITORY_ROOT, "scripts/data-wrangler-comparison-cache-controller.mjs");
export const DATA_WRANGLER_COMPARISON_CACHE_PYTHON_CONTROLLER_PATH = resolve(
  REPOSITORY_ROOT,
  "python/benchmarks/source_cache_control.py"
);
const SUPERVISOR_PATH = resolve(REPOSITORY_ROOT, "scripts/linux-study-supervisor.py");
const FIXTURE_CONTRACT_PATH = resolve(REPOSITORY_ROOT, "python/benchmarks/fixture_contract.py");
const FIXTURE_GENERATOR_PATH = resolve(REPOSITORY_ROOT, "python/benchmarks/installed_editor_fixtures.py");
export const DATA_WRANGLER_COMPARISON_JOURNEY_PATH = resolve(
  REPOSITORY_ROOT,
  "dist-test/test/extensionHost/dataWranglerComparisonNotebookTrial.js"
);
export const DATA_WRANGLER_COMPARISON_EXECUTION_ENTRY_PATHS = Object.freeze([
  resolve(REPOSITORY_ROOT, "scripts/run-data-wrangler-comparison-preparation.mjs"),
  resolve(REPOSITORY_ROOT, "scripts/run-data-wrangler-comparison-study-entry.mjs")
]);
const EXECUTION_GRAPH_ROOTS = Object.freeze(["scripts/", "src/shared/"]);
const EXECUTION_GRAPH_MAX_MODULES = 192;
const EXECUTION_GRAPH_MAX_BYTES = 12 * 1024 * 1024;
const EXECUTION_MODULE_MAX_BYTES = 1024 * 1024;
const EXECUTION_GRAPH_PARSER = Object.freeze({
  implementation: "typescript",
  version: ts.version,
  scriptKind: "JavaScript",
  scriptTarget: "Latest"
});
const RELATIVE_MODULE_SPECIFIER = /^\.\.?\/[A-Za-z0-9._/-]+\.(?:mjs|js|cjs)$/u;
const EXTERNAL_MODULE_SPECIFIER = /^(?:node:[a-z0-9_/-]+|@?[A-Za-z0-9][A-Za-z0-9._/-]*)$/u;
const PREPARE_LAUNCH_RECIPE =
  "npm run build:test-extension && node scripts/run-heavy-local-command.mjs comparison:prepare -- node scripts/run-data-wrangler-comparison-preparation.mjs";
const PREREGISTER_LAUNCH_RECIPE =
  "npm run build:test-extension && node scripts/run-heavy-local-command.mjs comparison:preregister -- node scripts/generate-data-wrangler-comparison-preregistration.mjs";
const STUDY_LAUNCH_RECIPE =
  "node scripts/run-heavy-local-command.mjs comparison:study -- node scripts/run-data-wrangler-comparison-study-entry.mjs";

const DISPLAY_REQUIREMENTS = Object.freeze({
  mode: "headless-ozone",
  widthPx: 1920,
  heightPx: 1080,
  deviceScaleFactor: 1,
  colorDepth: 24
});

const NOTEBOOK_LAYOUT = Object.freeze({
  theme: "Default Dark Modern",
  viewportWidthPx: 1920,
  viewportHeightPx: 1080,
  rowPageSize: 50,
  zoomLevel: 0
});
const PYTHON_PACKAGES = Object.freeze(["pandas", "polars", "pyarrow", "jupyter_core", "ipykernel"]);

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
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function fileSha256(path, label, captureFile) {
  return captureFile(path, label).sha256;
}

function executionModulePath(path) {
  const relativePath = relative(REPOSITORY_ROOT, path).split(sep).join("/");
  if (
    !EXECUTION_GRAPH_ROOTS.some((root) => relativePath.startsWith(root)) ||
    relativePath.includes("..") ||
    Buffer.byteLength(relativePath, "utf8") > 512
  ) {
    fail("Performance-study execution graph escaped the scripts directory.");
  }
  return relativePath;
}

function resolveExecutionImport(importer, specifier) {
  if (!RELATIVE_MODULE_SPECIFIER.test(specifier) || (specifier.includes("..") && !specifier.startsWith("../"))) {
    fail("Performance-study execution graph contains an invalid relative module specifier.");
  }
  const target = resolve(dirname(importer), specifier);
  const contained = relative(REPOSITORY_ROOT, target).split(sep).join("/");
  if (
    !isAbsolute(target) ||
    resolve(target) !== target ||
    ![".mjs", ".js", ".cjs"].includes(extname(target)) ||
    contained.length === 0 ||
    contained === ".." ||
    contained.startsWith("../") ||
    isAbsolute(contained) ||
    !EXECUTION_GRAPH_ROOTS.some((root) => contained.startsWith(root))
  ) {
    fail(
      `Performance-study execution graph contains unsupported local import ${specifier} from ${executionModulePath(importer)}.`
    );
  }
  return target;
}

function literalModuleSpecifier(node, importer, kind) {
  if (!node || (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node))) {
    fail(`Performance-study ${kind} in ${executionModulePath(importer)} must use one literal module specifier.`);
  }
  const specifier = node.text;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolveExecutionImport(importer, specifier);
    return { specifier, target, recordedTarget: executionModulePath(target) };
  }
  if (!EXTERNAL_MODULE_SPECIFIER.test(specifier)) {
    fail(`Performance-study ${kind} in ${executionModulePath(importer)} uses an unsupported module scheme.`);
  }
  return { specifier, target: null, recordedTarget: `external:${specifier}` };
}

function sourceModuleEdges(importer, source) {
  const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    fail(`Performance-study execution module ${executionModulePath(importer)} is not valid JavaScript.`);
  }
  const edges = [];
  const add = (node, kind) => {
    const resolved = literalModuleSpecifier(node, importer, kind);
    edges.push({
      from: executionModulePath(importer),
      kind,
      specifier: resolved.specifier,
      target: resolved.recordedTarget,
      localTarget: resolved.target
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, "import");
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node.moduleSpecifier, "export");
    else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1) fail("Performance-study dynamic import must have exactly one argument.");
        add(node.arguments[0], "dynamic-import");
      } else if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (node.arguments.length !== 1) fail("Performance-study require must have exactly one argument.");
        add(node.arguments[0], "require");
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isMetaProperty(node.expression.expression) &&
        node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.expression.name.text === "resolve"
      ) {
        if (node.arguments.length !== 1) fail("Performance-study import.meta.resolve must have exactly one argument.");
        add(node.arguments[0], "import-meta-resolve");
      } else if (
        (ts.isIdentifier(node.expression) && node.expression.text === "createRequire") ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          ((node.expression.expression.text === "module" && node.expression.name.text === "require") ||
            (node.expression.expression.text === "require" && node.expression.name.text === "resolve")))
      ) {
        fail(`Performance-study execution graph cannot audit a loader alias in ${executionModulePath(importer)}.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return edges;
}

export function proveDataWranglerComparisonExecutionGraph(
  entryPaths = DATA_WRANGLER_COMPARISON_EXECUTION_ENTRY_PATHS,
  { captureFile = captureDataWranglerComparisonPreregistrationFile } = {}
) {
  if (!Array.isArray(entryPaths) || entryPaths.length !== 2 || typeof captureFile !== "function") {
    fail("Performance-study execution graph requires its two reviewed entry modules.");
  }
  const entries = [...new Set(entryPaths.map((entry) => resolve(entry)))].sort();
  if (
    entries.length !== 2 ||
    entries.some((entry) => !DATA_WRANGLER_COMPARISON_EXECUTION_ENTRY_PATHS.includes(entry))
  ) {
    fail("Performance-study execution graph entry modules changed.");
  }
  const pending = [...entries];
  const visited = new Set();
  const modules = [];
  const edges = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    pending.sort();
    const path = pending.shift();
    if (visited.has(path)) continue;
    if (visited.size >= EXECUTION_GRAPH_MAX_MODULES)
      fail("Performance-study execution graph exceeds its module bound.");
    const captured = captureFile(path, `Performance-study execution module ${executionModulePath(path)}`, {
      maximumBytes: EXECUTION_MODULE_MAX_BYTES,
      includeText: true
    });
    const { text: source, ...receipt } = captured;
    if (
      typeof source !== "string" ||
      Buffer.byteLength(source, "utf8") !== receipt.filesystemIdentity?.sizeBytes ||
      !SHA256.test(receipt.sha256 ?? "")
    ) {
      fail("Performance-study execution module could not be read from its captured descriptor.");
    }
    totalBytes += receipt.filesystemIdentity.sizeBytes;
    if (totalBytes > EXECUTION_GRAPH_MAX_BYTES) fail("Performance-study execution graph exceeds its byte bound.");
    visited.add(path);
    modules.push({ path: executionModulePath(path), sha256: receipt.sha256 });
    for (const edge of sourceModuleEdges(path, source)) {
      const { localTarget, ...recorded } = edge;
      edges.push(recorded);
      if (localTarget !== null && !visited.has(localTarget)) pending.push(localTarget);
    }
  }
  modules.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  edges.sort((left, right) => {
    const leftCanonical = canonicalStudyJson(left);
    const rightCanonical = canonicalStudyJson(right);
    return leftCanonical < rightCanonical ? -1 : leftCanonical > rightCanonical ? 1 : 0;
  });
  for (let index = 1; index < edges.length; index += 1) {
    if (canonicalStudyJson(edges[index - 1]) === canonicalStudyJson(edges[index])) {
      fail("Performance-study execution graph contains a repeated module edge.");
    }
  }
  const relativeEntries = entries.map(executionModulePath);
  const externalSpecifiers = [
    ...new Set(edges.filter((edge) => edge.target.startsWith("external:")).map((edge) => edge.specifier))
  ].sort();
  const graph = {
    protocol: DATA_WRANGLER_COMPARISON_EXECUTION_GRAPH_PROTOCOL,
    scope: [...EXECUTION_GRAPH_ROOTS],
    parser: { ...EXECUTION_GRAPH_PARSER },
    entries: relativeEntries,
    moduleCount: modules.length,
    edgeCount: edges.length,
    totalBytes,
    externalSpecifiers,
    edges,
    modules
  };
  return Object.freeze({
    ...graph,
    scope: Object.freeze(graph.scope),
    parser: Object.freeze(graph.parser),
    entries: Object.freeze(graph.entries),
    externalSpecifiers: Object.freeze(graph.externalSpecifiers),
    graphSha256: digestStudyValue(graph),
    edges: Object.freeze(edges.map((entry) => Object.freeze(entry))),
    modules: Object.freeze(modules.map((entry) => Object.freeze(entry)))
  });
}

function sameFile(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function captureDataWranglerComparisonPreregistrationFile(
  path,
  label,
  { maximumBytes = 512 * 1024 * 1024, includeText = false } = {}
) {
  const target = resolve(path);
  if (
    target !== path ||
    typeof label !== "string" ||
    label.length === 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > 512 * 1024 * 1024 ||
    typeof includeText !== "boolean" ||
    (includeText && maximumBytes > EXECUTION_MODULE_MAX_BYTES)
  ) {
    fail("Performance-study preregistration file capture is malformed.");
  }
  let descriptor;
  try {
    const before = lstatSync(target, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(maximumBytes) ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
    ) {
      fail(`${label} must be one bounded, owned, singly linked regular file.`);
    }
    descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameFile(before, opened)) fail(`${label} changed while it opened.`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const chunks = includeText ? [] : null;
    let bytes = 0;
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      bytes += count;
      hash.update(buffer.subarray(0, count));
      if (chunks !== null) chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(target, { bigint: true });
    if (!sameFile(opened, after) || !sameFile(after, namedAfter) || BigInt(bytes) !== opened.size) {
      fail(`${label} changed while it was hashed.`);
    }
    const receipt = {
      sha256: hash.digest("hex"),
      filesystemIdentity: Object.freeze({
        device: opened.dev.toString(),
        inode: opened.ino.toString(),
        sizeBytes: Number(opened.size),
        mtimeNs: opened.mtimeNs.toString()
      })
    };
    if (chunks !== null) {
      try {
        receipt.text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        fail(`${label} is not valid UTF-8 source text.`);
      }
    }
    return Object.freeze(receipt);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fixtureDefinition(id, format, rows, columns) {
  return Object.freeze({
    id,
    format,
    rows,
    columns,
    schema: Object.freeze(
      Array.from({ length: columns }, (_unused, index) =>
        Object.freeze({ name: `c${String(index).padStart(2, "0")}`, dtype: "int64" })
      )
    ),
    sentinels: Object.freeze([
      Object.freeze({ rowIndex: 0, column: "c00", value: 0 }),
      Object.freeze({ rowIndex: 1, column: "c01", value: 2 }),
      Object.freeze({
        rowIndex: rows - 1,
        column: `c${String(columns - 1).padStart(2, "0")}`,
        value: rows + columns - 2
      })
    ])
  });
}

function expectedStudyDesign() {
  const schedule = createDataWranglerStudySchedule(DATA_WRANGLER_STUDY_SEED).map((entry) => ({ ...entry }));
  return {
    candidate: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
    baseline: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" },
    editor: { id: "Microsoft.VisualStudioCode", uiLocale: "en" },
    python: {
      implementation: "CPython",
      major: 3,
      minor: 12,
      packages: [...PYTHON_PACKAGES]
    },
    fixtures: [
      fixtureDefinition("csv-100k-50", "csv", 100_000, 50),
      fixtureDefinition("parquet-1m-20", "parquet", 1_000_000, 20)
    ],
    environment: {
      platform: "linux",
      architecture: "x64",
      powerSource: "ac",
      affinityPolicy: "explicit-online-cpu-set",
      storagePolicy: "exact-fixture-volume",
      display: { ...DISPLAY_REQUIREMENTS },
      zoom: {
        level: NOTEBOOK_LAYOUT.zoomLevel,
        theme: NOTEBOOK_LAYOUT.theme,
        viewportWidthPx: NOTEBOOK_LAYOUT.viewportWidthPx,
        viewportHeightPx: NOTEBOOK_LAYOUT.viewportHeightPx,
        rowPageSize: NOTEBOOK_LAYOUT.rowPageSize,
        notebookLayoutSha256: digestStudyValue(NOTEBOOK_LAYOUT)
      },
      commonExtensions: DATA_WRANGLER_COMPARISON_BASE_EXTENSIONS.map((entry) => ({ ...entry }))
    },
    sampling: {
      seed: DATA_WRANGLER_STUDY_SEED,
      warmPairsPerCell: DATA_WRANGLER_STUDY_WARM_PAIRS_PER_CELL,
      coldPairsPerOrder: 1,
      scheduleSha256: DATA_WRANGLER_STUDY_SCHEDULE_SHA256,
      cells: DATA_WRANGLER_STUDY_CELLS.map((entry) => ({ ...entry })),
      schedule
    },
    deadlinesMs: { ...DATA_WRANGLER_STUDY_DEADLINES_MS },
    metrics: DATA_WRANGLER_STUDY_METRICS.map((entry) => ({ ...entry })),
    descriptiveMetrics: [...DATA_WRANGLER_STUDY_DESCRIPTIVE_METRICS]
  };
}

function readPlaywrightLock(captureFile) {
  const receipt = captureFile(PACKAGE_LOCK_PATH, "Performance-study package lock", {
    maximumBytes: 4 * 1024 * 1024
  });
  const parsed = readBoundedDataWranglerComparisonSpecificationDraft(PACKAGE_LOCK_PATH);
  const entry = parsed?.packages?.["node_modules/playwright-core"];
  if (
    !isRecord(entry) ||
    entry.version !== "1.61.1" ||
    typeof entry.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
  ) {
    fail("Performance-study package lock does not pin Playwright Core 1.61.1 exactly.");
  }
  return Object.freeze({ sha256: receipt.sha256, version: entry.version, integrity: entry.integrity });
}

function readPackageLaunchRecipe(captureFile) {
  const receipt = captureFile(PACKAGE_JSON_PATH, "Performance-study package launch recipes", {
    maximumBytes: 1024 * 1024
  });
  const value = readBoundedDataWranglerComparisonSpecificationDraft(PACKAGE_JSON_PATH);
  if (
    value?.scripts?.["comparison:prepare"] !== PREPARE_LAUNCH_RECIPE ||
    value?.scripts?.["comparison:preregister"] !== PREREGISTER_LAUNCH_RECIPE ||
    value?.scripts?.["comparison:study"] !== STUDY_LAUNCH_RECIPE
  ) {
    fail("Performance-study public npm launch recipes changed.");
  }
  return Object.freeze({
    packageJsonSha256: receipt.sha256,
    prepare: PREPARE_LAUNCH_RECIPE,
    study: STUDY_LAUNCH_RECIPE
  });
}

function validatePreregistrationReceipt(receipt) {
  exactKeys(receipt, ["protocol", "sha256"], "Performance-study preregistration receipt");
  if (
    receipt.protocol !== DATA_WRANGLER_COMPARISON_PREREGISTRATION_RECEIPT_PROTOCOL ||
    typeof receipt.sha256 !== "string" ||
    !SHA256.test(receipt.sha256)
  ) {
    fail("Performance-study preregistration receipt is invalid.");
  }
  return receipt;
}

export function createDataWranglerComparisonPreregistrationReceipt(preregistration) {
  validateDataWranglerComparisonPreregistration(preregistration);
  return Object.freeze({
    protocol: DATA_WRANGLER_COMPARISON_PREREGISTRATION_RECEIPT_PROTOCOL,
    sha256: digestStudyValue(preregistration)
  });
}

export function captureDataWranglerComparisonPreregistration(
  {
    studyId = randomUUID(),
    createdAtUtc = new Date().toISOString(),
    journeyPath = DATA_WRANGLER_COMPARISON_JOURNEY_PATH
  } = {},
  {
    captureFile = captureDataWranglerComparisonPreregistrationFile,
    captureMethodology = captureDataWranglerStudyMethodReceipt,
    proveJourneyGraph,
    proveExecutionGraph = (entries) => proveDataWranglerComparisonExecutionGraph(entries)
  } = {}
) {
  if (!UUID.test(studyId) || !ISO_UTC.test(createdAtUtc)) {
    fail("Performance-study preregistration requires a UUID and millisecond UTC timestamp.");
  }
  if (typeof proveJourneyGraph !== "function" || typeof proveExecutionGraph !== "function") {
    fail("Performance-study preregistration requires its audited journey and execution graph provers.");
  }
  const graph = proveJourneyGraph(resolve(journeyPath));
  const executionGraph = proveExecutionGraph(DATA_WRANGLER_COMPARISON_EXECUTION_ENTRY_PATHS);
  const lock = readPlaywrightLock(captureFile);
  const launchRecipe = readPackageLaunchRecipe(captureFile);
  const value = {
    protocol: DATA_WRANGLER_COMPARISON_PREREGISTRATION_PROTOCOL,
    studyId,
    createdAtUtc,
    method: structuredClone(captureMethodology()),
    design: expectedStudyDesign(),
    driverRecipe: {
      extension: { ...DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION },
      journeyGraph: structuredClone(graph),
      packageLockSha256: lock.sha256,
      playwrightCore: { version: lock.version, lockIntegrity: lock.integrity },
      packagerSha256: fileSha256(DRIVER_PACKAGER_PATH, "Performance-study driver packager", captureFile)
    },
    toolRecipes: {
      executionGraph: structuredClone(executionGraph),
      launchRecipe: structuredClone(launchRecipe),
      preregistrationToolSha256: fileSha256(
        PREREGISTRATION_TOOL_PATH,
        "Performance-study preregistration tool",
        captureFile
      ),
      preparationToolSha256: fileSha256(PREPARATION_TOOL_PATH, "Performance-study preparation tool", captureFile),
      environmentCaptureSha256: fileSha256(
        ENVIRONMENT_CAPTURE_PATH,
        "Performance-study environment capture",
        captureFile
      ),
      studyRuntimeSha256: fileSha256(STUDY_RUNTIME_PATH, "Performance-study validator and ledger", captureFile),
      durablePublisherSha256: fileSha256(DURABLE_PUBLISHER_PATH, "Performance-study durable publisher", captureFile),
      cacheHarnessSha256: fileSha256(
        CACHE_HARNESS_PATH,
        "Performance-study source-cache JavaScript harness",
        captureFile
      ),
      cachePythonControllerSha256: fileSha256(
        DATA_WRANGLER_COMPARISON_CACHE_PYTHON_CONTROLLER_PATH,
        "Performance-study source-cache Python controller",
        captureFile
      ),
      fixtureGeneratorSha256: fileSha256(FIXTURE_GENERATOR_PATH, "Performance-study fixture generator", captureFile),
      fixtureContractSha256: fileSha256(FIXTURE_CONTRACT_PATH, "Performance-study fixture contract", captureFile),
      supervisorSourceSha256: fileSha256(SUPERVISOR_PATH, "Performance-study process supervisor", captureFile),
      supervisorInvocationPolicySha256: digestLinuxStudySupervisorValue(LINUX_STUDY_SUPERVISOR_INVOCATION_POLICY),
      supervisorProtocol: LINUX_STUDY_SUPERVISOR_PROTOCOL
    }
  };
  return validateDataWranglerComparisonPreregistration(value);
}

export function validateDataWranglerComparisonPreregistration(value) {
  exactKeys(
    value,
    ["protocol", "studyId", "createdAtUtc", "method", "design", "driverRecipe", "toolRecipes"],
    "Performance-study preregistration"
  );
  if (
    value.protocol !== DATA_WRANGLER_COMPARISON_PREREGISTRATION_PROTOCOL ||
    !UUID.test(value.studyId ?? "") ||
    !ISO_UTC.test(value.createdAtUtc ?? "")
  ) {
    fail("Performance-study preregistration identity is invalid.");
  }
  exactKeys(value.method, ["protocol", "sha256"], "Performance-study methodology receipt");
  if (value.method.protocol !== DATA_WRANGLER_STUDY_METHOD_PROTOCOL || !SHA256.test(value.method.sha256 ?? "")) {
    fail("Performance-study methodology receipt is invalid.");
  }
  exactKeys(
    value.design,
    [
      "candidate",
      "baseline",
      "editor",
      "python",
      "fixtures",
      "environment",
      "sampling",
      "deadlinesMs",
      "metrics",
      "descriptiveMetrics"
    ],
    "Performance-study design"
  );
  if (canonicalStudyJson(value.design) !== canonicalStudyJson(expectedStudyDesign())) {
    fail("Performance-study schedule or limits changed.");
  }
  exactKeys(
    value.driverRecipe,
    ["extension", "journeyGraph", "packageLockSha256", "playwrightCore", "packagerSha256"],
    "Performance-study driver recipe"
  );
  if (
    canonicalStudyJson(value.driverRecipe.extension) !==
      canonicalStudyJson(DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION) ||
    value.driverRecipe.journeyGraph?.entry !== "test/extensionHost/dataWranglerComparisonNotebookTrial.js" ||
    !SHA256.test(value.driverRecipe.journeyGraph?.graphSha256 ?? "") ||
    !SHA256.test(value.driverRecipe.packageLockSha256 ?? "") ||
    value.driverRecipe.playwrightCore?.version !== "1.61.1" ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value.driverRecipe.playwrightCore?.lockIntegrity ?? "") ||
    !SHA256.test(value.driverRecipe.packagerSha256 ?? "")
  ) {
    fail("Performance-study driver recipe is invalid.");
  }
  exactKeys(
    value.driverRecipe.journeyGraph,
    ["entry", "moduleCount", "totalBytes", "graphSha256", "modules"],
    "Performance-study journey graph"
  );
  if (
    !Number.isSafeInteger(value.driverRecipe.journeyGraph.moduleCount) ||
    value.driverRecipe.journeyGraph.moduleCount < 1 ||
    value.driverRecipe.journeyGraph.moduleCount > 64 ||
    !Number.isSafeInteger(value.driverRecipe.journeyGraph.totalBytes) ||
    value.driverRecipe.journeyGraph.totalBytes < 1 ||
    value.driverRecipe.journeyGraph.totalBytes > 2 * 1024 * 1024 ||
    !Array.isArray(value.driverRecipe.journeyGraph.modules) ||
    value.driverRecipe.journeyGraph.modules.length !== value.driverRecipe.journeyGraph.moduleCount
  ) {
    fail("Performance-study journey graph bounds are invalid.");
  }
  const modulePaths = new Set();
  let previousPath = "";
  for (const module of value.driverRecipe.journeyGraph.modules) {
    exactKeys(module, ["path", "sha256"], "Performance-study journey module");
    if (
      typeof module.path !== "string" ||
      module.path.length > 512 ||
      !/^(?:shared|test\/extensionHost)\/[A-Za-z0-9._/-]+$/u.test(module.path) ||
      module.path.includes("..") ||
      module.path <= previousPath ||
      modulePaths.has(module.path) ||
      !SHA256.test(module.sha256 ?? "")
    ) {
      fail("Performance-study journey module inventory is invalid.");
    }
    modulePaths.add(module.path);
    previousPath = module.path;
  }
  if (
    !modulePaths.has(value.driverRecipe.journeyGraph.entry) ||
    createHash("sha256").update(JSON.stringify(value.driverRecipe.journeyGraph.modules), "utf8").digest("hex") !==
      value.driverRecipe.journeyGraph.graphSha256
  ) {
    fail("Performance-study journey graph digest is invalid.");
  }
  exactKeys(value.driverRecipe.playwrightCore, ["version", "lockIntegrity"], "Playwright recipe");
  exactKeys(
    value.toolRecipes,
    [
      "executionGraph",
      "launchRecipe",
      "cacheHarnessSha256",
      "cachePythonControllerSha256",
      "durablePublisherSha256",
      "environmentCaptureSha256",
      "fixtureGeneratorSha256",
      "fixtureContractSha256",
      "preparationToolSha256",
      "preregistrationToolSha256",
      "studyRuntimeSha256",
      "supervisorSourceSha256",
      "supervisorInvocationPolicySha256",
      "supervisorProtocol"
    ],
    "Performance-study tool recipes"
  );
  exactKeys(
    value.toolRecipes.launchRecipe,
    ["packageJsonSha256", "prepare", "study"],
    "Performance-study public launch recipe"
  );
  if (
    !SHA256.test(value.toolRecipes.launchRecipe.packageJsonSha256 ?? "") ||
    value.toolRecipes.launchRecipe.prepare !== PREPARE_LAUNCH_RECIPE ||
    value.toolRecipes.launchRecipe.study !== STUDY_LAUNCH_RECIPE
  ) {
    fail("Performance-study public launch recipe is invalid.");
  }
  exactKeys(
    value.toolRecipes.executionGraph,
    [
      "protocol",
      "scope",
      "parser",
      "entries",
      "moduleCount",
      "edgeCount",
      "totalBytes",
      "externalSpecifiers",
      "graphSha256",
      "modules",
      "edges"
    ],
    "Performance-study execution graph"
  );
  const executionGraph = value.toolRecipes.executionGraph;
  exactKeys(
    executionGraph.parser,
    ["implementation", "version", "scriptKind", "scriptTarget"],
    "Execution graph parser"
  );
  if (
    executionGraph.protocol !== DATA_WRANGLER_COMPARISON_EXECUTION_GRAPH_PROTOCOL ||
    canonicalStudyJson(executionGraph.scope) !== canonicalStudyJson(EXECUTION_GRAPH_ROOTS) ||
    canonicalStudyJson(executionGraph.parser) !== canonicalStudyJson(EXECUTION_GRAPH_PARSER) ||
    canonicalStudyJson(executionGraph.entries) !==
      canonicalStudyJson(DATA_WRANGLER_COMPARISON_EXECUTION_ENTRY_PATHS.map(executionModulePath)) ||
    !Number.isSafeInteger(executionGraph.moduleCount) ||
    executionGraph.moduleCount < 2 ||
    executionGraph.moduleCount > EXECUTION_GRAPH_MAX_MODULES ||
    !Number.isSafeInteger(executionGraph.totalBytes) ||
    executionGraph.totalBytes < 1 ||
    executionGraph.totalBytes > EXECUTION_GRAPH_MAX_BYTES ||
    !Array.isArray(executionGraph.modules) ||
    executionGraph.modules.length !== executionGraph.moduleCount ||
    !Array.isArray(executionGraph.edges) ||
    !Number.isSafeInteger(executionGraph.edgeCount) ||
    executionGraph.edgeCount !== executionGraph.edges.length ||
    executionGraph.edges.length < executionGraph.moduleCount ||
    executionGraph.edges.length > 2048 ||
    !Array.isArray(executionGraph.externalSpecifiers)
  ) {
    fail("Performance-study execution graph bounds or entry points are invalid.");
  }
  let previousExecutionPath = "";
  const executionPaths = new Set();
  for (const module of executionGraph.modules) {
    exactKeys(module, ["path", "sha256"], "Performance-study execution module");
    if (
      typeof module.path !== "string" ||
      !EXECUTION_GRAPH_ROOTS.some((root) => module.path.startsWith(root)) ||
      module.path.includes("..") ||
      module.path <= previousExecutionPath ||
      executionPaths.has(module.path) ||
      !SHA256.test(module.sha256 ?? "")
    ) {
      fail("Performance-study execution graph module inventory is invalid.");
    }
    previousExecutionPath = module.path;
    executionPaths.add(module.path);
  }
  let previousExecutionEdge = "";
  const observedExternalSpecifiers = new Set();
  const adjacency = new Map([...executionPaths].map((path) => [path, []]));
  for (const edge of executionGraph.edges) {
    exactKeys(edge, ["from", "kind", "specifier", "target"], "Performance-study execution edge");
    const canonicalEdge = canonicalStudyJson(edge);
    const localTarget = typeof edge.target === "string" && !edge.target.startsWith("external:");
    if (
      !executionPaths.has(edge.from) ||
      !["import", "export", "dynamic-import", "require", "import-meta-resolve"].includes(edge.kind) ||
      typeof edge.specifier !== "string" ||
      typeof edge.target !== "string" ||
      (localTarget && !executionPaths.has(edge.target)) ||
      (!localTarget && edge.target !== `external:${edge.specifier}`) ||
      canonicalEdge <= previousExecutionEdge
    ) {
      fail("Performance-study execution edge inventory is invalid.");
    }
    if (localTarget) adjacency.get(edge.from).push(edge.target);
    else observedExternalSpecifiers.add(edge.specifier);
    previousExecutionEdge = canonicalEdge;
  }
  let previousExternalSpecifier = "";
  for (const specifier of executionGraph.externalSpecifiers) {
    if (
      typeof specifier !== "string" ||
      !EXTERNAL_MODULE_SPECIFIER.test(specifier) ||
      specifier <= previousExternalSpecifier ||
      !observedExternalSpecifiers.has(specifier)
    ) {
      fail("Performance-study execution graph external module inventory is invalid.");
    }
    previousExternalSpecifier = specifier;
  }
  if (executionGraph.externalSpecifiers.length !== observedExternalSpecifiers.size) {
    fail("Performance-study execution graph external module inventory is incomplete.");
  }
  const reachable = new Set(executionGraph.entries);
  const pendingExecutionPaths = [...executionGraph.entries];
  while (pendingExecutionPaths.length > 0) {
    const from = pendingExecutionPaths.pop();
    for (const target of adjacency.get(from)) {
      if (!reachable.has(target)) {
        reachable.add(target);
        pendingExecutionPaths.push(target);
      }
    }
  }
  const graphDigestInput = {
    protocol: executionGraph.protocol,
    scope: executionGraph.scope,
    parser: executionGraph.parser,
    entries: executionGraph.entries,
    moduleCount: executionGraph.moduleCount,
    edgeCount: executionGraph.edgeCount,
    totalBytes: executionGraph.totalBytes,
    externalSpecifiers: executionGraph.externalSpecifiers,
    edges: executionGraph.edges,
    modules: executionGraph.modules
  };
  if (
    executionGraph.entries.some((entry) => !executionPaths.has(entry)) ||
    reachable.size !== executionGraph.moduleCount ||
    digestStudyValue(graphDigestInput) !== executionGraph.graphSha256
  ) {
    fail("Performance-study execution graph digest is invalid.");
  }
  for (const key of [
    "cacheHarnessSha256",
    "cachePythonControllerSha256",
    "durablePublisherSha256",
    "environmentCaptureSha256",
    "fixtureGeneratorSha256",
    "fixtureContractSha256",
    "preparationToolSha256",
    "preregistrationToolSha256",
    "studyRuntimeSha256",
    "supervisorSourceSha256",
    "supervisorInvocationPolicySha256"
  ]) {
    if (!SHA256.test(value.toolRecipes[key] ?? "")) fail(`Performance-study ${key} is invalid.`);
  }
  if (value.toolRecipes.supervisorProtocol !== LINUX_STUDY_SUPERVISOR_PROTOCOL) {
    fail("Performance-study supervisor protocol changed.");
  }
  return value;
}

export function assertCurrentDataWranglerComparisonPreregistration(preregistration, options = {}, dependencies = {}) {
  validateDataWranglerComparisonPreregistration(preregistration);
  const currentDependencies = {
    ...dependencies,
    proveJourneyGraph:
      dependencies.proveJourneyGraph ?? (() => structuredClone(preregistration.driverRecipe.journeyGraph))
  };
  const observed = captureDataWranglerComparisonPreregistration(
    {
      studyId: preregistration.studyId,
      createdAtUtc: preregistration.createdAtUtc,
      ...options
    },
    currentDependencies
  );
  if (canonicalStudyJson(observed) !== canonicalStudyJson(preregistration)) {
    fail("Performance-study preregistration no longer matches its checked-in design and tool recipes.");
  }
  return preregistration;
}

export function writeDataWranglerComparisonPreregistration(path, value, options = {}) {
  validateDataWranglerComparisonPreregistration(value);
  const target = resolve(path);
  const digest = digestDurableJsonValue(value);
  const recovered = recoverDurableStudyJsonPublication(target, digest, {
    maximumBytes: MAXIMUM_PREREGISTRATION_BYTES,
    ...options
  });
  if (recovered.status !== "absent") return recovered;
  return publishDurableStudyJsonExclusive(target, value, {
    maximumBytes: MAXIMUM_PREREGISTRATION_BYTES,
    ...options
  });
}

export function readDataWranglerComparisonPreregistration(path) {
  return validateDataWranglerComparisonPreregistration(
    readBoundedDataWranglerComparisonSpecificationDraft(resolve(path))
  );
}

export function validateDataWranglerComparisonPreregistrationReceipt(receipt) {
  return validatePreregistrationReceipt(receipt);
}
