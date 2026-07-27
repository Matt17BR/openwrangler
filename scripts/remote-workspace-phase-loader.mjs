import { builtinModules } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { readBoundedRemoteWorkspaceFile } from "./remote-workspace-contract.mjs";
import {
  assertRemoteWorkspaceExactFileStage,
  captureRemoteWorkspaceTreeManifest,
  stageRemoteWorkspaceExactFile
} from "./remote-workspace-staging.mjs";

const PHASE_ENTRYPOINT = "remote-workspace-phase-child.mjs";
const PHASE_MODULE_NAMES = Object.freeze([
  PHASE_ENTRYPOINT,
  "remote-workspace-contract.mjs",
  "remote-workspace-processes.mjs"
]);
const PHASE_RUNTIME_FILE_NAMES = Object.freeze([...PHASE_MODULE_NAMES, "Xvfb"].sort());
const MODULE_MAXIMUM_BYTES = 512 * 1024;
const PHASE_RUNTIME_BOUNDS = Object.freeze({
  label: "Remote SSH phase-loader runtime",
  maximumFiles: 8,
  maximumBytes: 2 * 1024 * 1024,
  maximumFileBytes: 1024 * 1024
});
const NODE_BUILTINS = new Set(
  builtinModules.map((specifier) => (specifier.startsWith("node:") ? specifier : `node:${specifier}`))
);

export function validateRemoteWorkspacePhaseModuleClosure(root, { readFile = readBoundedRemoteWorkspaceFile } = {}) {
  const canonicalRoot = canonicalDirectory(root, "source root");
  if (typeof readFile !== "function") {
    throw new Error("The Remote SSH phase-loader module reader is malformed.");
  }
  const modules = PHASE_MODULE_NAMES.map((name) => {
    const path = join(canonicalRoot, name);
    const source = readFile(path, MODULE_MAXIMUM_BYTES);
    const imports = inspectModule(name, source);
    return Object.freeze({
      name,
      localImports: Object.freeze([...imports.localImports].sort()),
      nodeImports: Object.freeze([...imports.nodeImports].sort())
    });
  });
  const byName = new Map(modules.map((module) => [module.name, module]));
  const reachable = new Set();
  const pending = [PHASE_ENTRYPOINT];
  while (pending.length > 0) {
    const name = pending.shift();
    if (reachable.has(name)) continue;
    const module = byName.get(name);
    if (!module) {
      throw new Error("The Remote SSH phase-loader imports a module outside its fixed closure.");
    }
    reachable.add(name);
    pending.push(...module.localImports);
  }
  if (reachable.size !== PHASE_MODULE_NAMES.length || PHASE_MODULE_NAMES.some((name) => !reachable.has(name))) {
    throw new Error("The Remote SSH phase-loader fixed module closure contains an unreachable module.");
  }
  return Object.freeze({
    root: canonicalRoot,
    entrypoint: PHASE_ENTRYPOINT,
    modules: Object.freeze(modules)
  });
}

export function stageRemoteWorkspacePhaseLoader(sourceRoot, stagedRoot, xvfbSource) {
  const sourceClosure = validateRemoteWorkspacePhaseModuleClosure(sourceRoot);
  const destinationRoot = canonicalDirectory(stagedRoot, "staged root");
  if (
    isSameOrContained(sourceClosure.root, destinationRoot) ||
    isSameOrContained(destinationRoot, sourceClosure.root)
  ) {
    throw new Error("The Remote SSH phase-loader source and staged roots must be independent.");
  }
  const moduleStages = sourceClosure.modules.map((module) =>
    stageRemoteWorkspaceExactFile(join(sourceClosure.root, module.name), join(destinationRoot, module.name))
  );
  const xvfbStage = stageRemoteWorkspaceExactFile(xvfbSource, join(destinationRoot, "Xvfb"), 0o700);
  const stagedClosure = validateRemoteWorkspacePhaseModuleClosure(destinationRoot);
  assertClosureGraphEqual(sourceClosure, stagedClosure);
  const stage = Object.freeze({
    sourceRoot: sourceClosure.root,
    stagedRoot: destinationRoot,
    sourceClosure,
    stagedClosure,
    moduleStages: Object.freeze(moduleStages),
    xvfbStage,
    entrypoint: join(destinationRoot, PHASE_ENTRYPOINT),
    manifest: captureExactPhaseRuntimeManifest(destinationRoot)
  });
  assertRemoteWorkspacePhaseLoaderStage(stage);
  return stage;
}

export function assertRemoteWorkspacePhaseLoaderStage(stage) {
  if (
    !stage ||
    typeof stage !== "object" ||
    !Array.isArray(stage.moduleStages) ||
    stage.moduleStages.length !== PHASE_MODULE_NAMES.length ||
    typeof stage.sourceRoot !== "string" ||
    typeof stage.stagedRoot !== "string" ||
    stage.entrypoint !== join(stage.stagedRoot, PHASE_ENTRYPOINT)
  ) {
    throw new Error("The Remote SSH phase-loader stage receipt is malformed.");
  }
  const moduleStagesByName = new Map();
  for (const moduleStage of stage.moduleStages) {
    assertRemoteWorkspaceExactFileStage(moduleStage);
    const name = basename(moduleStage.sourcePath);
    if (
      !PHASE_MODULE_NAMES.includes(name) ||
      moduleStagesByName.has(name) ||
      moduleStage.sourcePath !== join(stage.sourceRoot, name) ||
      moduleStage.stagedPath !== join(stage.stagedRoot, name)
    ) {
      throw new Error("The Remote SSH phase-loader stage receipt is malformed.");
    }
    moduleStagesByName.set(name, moduleStage);
  }
  if (PHASE_MODULE_NAMES.some((name) => !moduleStagesByName.has(name))) {
    throw new Error("The Remote SSH phase-loader stage receipt is malformed.");
  }
  assertRemoteWorkspaceExactFileStage(stage.xvfbStage);
  if (stage.xvfbStage.stagedPath !== join(stage.stagedRoot, "Xvfb") || stage.xvfbStage.mode !== 0o700) {
    throw new Error("The Remote SSH phase-loader Xvfb stage receipt is malformed.");
  }
  const sourceClosure = validateRemoteWorkspacePhaseModuleClosure(stage.sourceRoot);
  const stagedClosure = validateRemoteWorkspacePhaseModuleClosure(stage.stagedRoot);
  assertClosureGraphEqual(sourceClosure, stagedClosure);
  if (
    !isDeepStrictEqual(sourceClosure, stage.sourceClosure) ||
    !isDeepStrictEqual(stagedClosure, stage.stagedClosure) ||
    !isDeepStrictEqual(captureExactPhaseRuntimeManifest(stage.stagedRoot), stage.manifest)
  ) {
    throw new Error("The Remote SSH phase-loader closure changed after it was pinned.");
  }
  return stage;
}

function inspectModule(name, source) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") <= 0 ||
    Buffer.byteLength(source, "utf8") > MODULE_MAXIMUM_BYTES
  ) {
    throw new Error("A Remote SSH phase-loader module is malformed.");
  }
  const sourceFile = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new Error("A Remote SSH phase-loader module contains invalid JavaScript.");
  }
  const localImports = new Set();
  const nodeImports = new Set();
  const recordSpecifier = (moduleSpecifier) => {
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      throw new Error("A Remote SSH phase-loader import is not one static string literal.");
    }
    const specifier = moduleSpecifier.text;
    if (specifier.startsWith("node:")) {
      if (!NODE_BUILTINS.has(specifier)) {
        throw new Error("A Remote SSH phase-loader import is not one known Node builtin.");
      }
      nodeImports.add(specifier);
      return;
    }
    if (
      !/^\.\/[a-z0-9-]+\.mjs$/u.test(specifier) ||
      specifier.includes("?") ||
      specifier.includes("#") ||
      specifier.includes("\\")
    ) {
      throw new Error("A Remote SSH phase-loader import escaped its fixed local ESM closure.");
    }
    const dependency = specifier.slice(2);
    if (!PHASE_MODULE_NAMES.includes(dependency)) {
      throw new Error("A Remote SSH phase-loader import escaped its fixed local ESM closure.");
    }
    localImports.add(dependency);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      recordSpecifier(node.moduleSpecifier);
      if (
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (element) => (element.propertyName ?? element.name).text === "createRequire"
        )
      ) {
        throw new Error("A Remote SSH phase-loader module may not create a CommonJS loader.");
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      recordSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      throw new Error("A Remote SSH phase-loader module may use only static ESM imports.");
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error("A Remote SSH phase-loader module may not use dynamic import.");
      }
      if (
        (ts.isIdentifier(node.expression) &&
          (node.expression.text === "require" || node.expression.text === "createRequire")) ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "createRequire")
      ) {
        throw new Error("A Remote SSH phase-loader module may not create or use a CommonJS loader.");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return Object.freeze({ localImports, nodeImports });
}

function assertClosureGraphEqual(source, staged) {
  const graph = (closure) =>
    closure.modules.map(({ name, localImports, nodeImports }) => ({
      name,
      localImports: [...localImports],
      nodeImports: [...nodeImports]
    }));
  if (!isDeepStrictEqual(graph(source), graph(staged))) {
    throw new Error("The Remote SSH staged phase-loader graph differs from its fixed source closure.");
  }
}

function captureExactPhaseRuntimeManifest(root) {
  const manifest = captureRemoteWorkspaceTreeManifest(root, PHASE_RUNTIME_BOUNDS);
  if (
    manifest.links.length !== 0 ||
    manifest.directories.length !== 1 ||
    manifest.directories[0].path !== "." ||
    manifest.files
      .map((file) => file.path)
      .sort()
      .join(",") !== PHASE_RUNTIME_FILE_NAMES.join(",")
  ) {
    throw new Error("The Remote SSH phase-loader runtime does not contain its exact root-only file manifest.");
  }
  return manifest;
}

function canonicalDirectory(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || path.length > 16_384) {
    throw new Error(`The Remote SSH phase-loader ${label} is malformed.`);
  }
  const canonical = realpathSync(path);
  const metadata = lstatSync(path);
  if (canonical !== path || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The Remote SSH phase-loader ${label} is not one canonical directory.`);
  }
  return canonical;
}

function isSameOrContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length === 0 || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}
