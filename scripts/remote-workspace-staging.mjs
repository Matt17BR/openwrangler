import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  readlinkSync,
  realpathSync
} from "node:fs";
import { builtinModules } from "node:module";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { assertRemoteWorkspaceFileReceipt, captureRemoteWorkspaceFileReceipt } from "./remote-workspace-provenance.mjs";

const MAXIMUM_TREE_BYTES = 4 * 1024 * 1024 * 1024;
const MAXIMUM_TREE_FILES = 100_000;
const RECEIPT_PERMISSIONS = 0o777n;
const COMMONJS_DEFAULT_LIMITS = Object.freeze({
  maximumBytes: 16 * 1024 * 1024,
  maximumEdges: 4_096,
  maximumFileBytes: 4 * 1024 * 1024,
  maximumModules: 512
});
const COMMONJS_BUILTINS = new Set(
  builtinModules.flatMap((name) => (name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`]))
);

export function reconcileGeneratedCommonJsFileClosure(options) {
  const policy = normalizeCommonJsPolicy(options);
  const root = canonicalDirectoryPath(options?.root, "generated CommonJS closure root");
  const entrypoint = commonJsCanonicalModulePath(root, options?.entrypoint, "entrypoint");
  const rootReceipt = directoryReceipt(root);
  const receipts = new Map();
  const resolvedReceipts = new Map();
  const result = reconcileCommonJsClosure({
    ...policy,
    entrypoint: commonJsRelativeModulePath(root, entrypoint),
    load(modulePath) {
      const absolute = commonJsCanonicalModulePath(root, resolve(root, ...modulePath.split("/")), "compiled module");
      const resolvedReceipt = resolvedReceipts.get(absolute);
      if (resolvedReceipt !== undefined) {
        assertPinnedCommonJsModule(absolute, resolvedReceipt, policy.limits.maximumFileBytes);
      }
      const captured = readPinnedCommonJsModule(absolute, policy.limits.maximumFileBytes);
      receipts.set(absolute, captured.receipt);
      return captured.source;
    },
    resolveLocal(fromModule, specifier) {
      return resolveCommonJsFileModule(
        root,
        resolveCommonJsLocalPath(fromModule, specifier),
        policy.limits.maximumFileBytes,
        (path, receipt) => {
          const existing = resolvedReceipts.get(path);
          if (existing !== undefined && !isDeepStrictEqual(existing, receipt)) {
            throw new Error("A generated CommonJS local edge changed after its identity was pinned.");
          }
          resolvedReceipts.set(path, receipt);
        }
      );
    }
  });
  if (!isDeepStrictEqual(directoryReceipt(root), rootReceipt)) {
    throw new Error("The generated CommonJS closure root changed during reconciliation.");
  }
  for (const [path, receipt] of receipts) {
    assertPinnedCommonJsModule(path, receipt, policy.limits.maximumFileBytes);
  }
  return result;
}

export function reconcileOpenWranglerCompiledCommonJsClosure({ root, outputRoot }) {
  if (outputRoot !== "dist" && outputRoot !== "dist-test") {
    throw new Error("Open Wrangler compiled CommonJS closure requires the dist or dist-test output root.");
  }
  const canonicalRoot = canonicalDirectoryPath(root, "Open Wrangler compiled repository root");
  const compiledRoot = canonicalDirectoryPath(resolve(canonicalRoot, outputRoot), "Open Wrangler compiled output root");
  const policy = {
    root: compiledRoot,
    expectedHostExternals: ["vscode"],
    expectedPackagedExternals: outputRoot === "dist-test" ? ["playwright-core"] : [],
    limits: {
      maximumModules: 256,
      maximumEdges: 4_096,
      maximumFileBytes: 4 * 1024 * 1024,
      maximumBytes: 16 * 1024 * 1024
    }
  };
  return reconcileGeneratedCommonJsFileClosure({
    ...policy,
    entrypoint:
      outputRoot === "dist-test"
        ? resolve(compiledRoot, "test", "extensionHost", "index.js")
        : resolve(compiledRoot, "extension", "activate.js")
  });
}

export function reconcileGeneratedCommonJsModuleClosure(options) {
  const policy = normalizeCommonJsPolicy(options);
  const modules = normalizeCommonJsModules(options?.modules, policy.limits);
  const entrypoint = normalizeCommonJsModulePath(options?.entrypoint, "entrypoint");
  if (!modules.has(entrypoint)) {
    throw new Error("The generated CommonJS entrypoint is missing from its module map.");
  }
  return reconcileCommonJsClosure({
    ...policy,
    entrypoint,
    load(modulePath) {
      const source = modules.get(modulePath);
      if (source === undefined) throw new Error("A generated CommonJS local edge is unresolved.");
      return source;
    },
    resolveLocal(fromModule, specifier) {
      return resolveCommonJsMappedModule(modules, resolveCommonJsLocalPath(fromModule, specifier));
    }
  });
}

function reconcileCommonJsClosure({
  entrypoint,
  expectedHostExternals,
  expectedPackagedExternals,
  limits,
  load,
  resolveLocal
}) {
  const queue = [entrypoint];
  const visited = new Set();
  const hostExternals = new Set();
  const packagedExternals = new Set();
  let bytes = 0;
  let edges = 0;
  while (queue.length > 0) {
    const modulePath = queue.shift();
    if (visited.has(modulePath)) continue;
    if (visited.size >= limits.maximumModules) {
      throw new Error("The generated CommonJS closure exceeded its module bound.");
    }
    const source = load(modulePath);
    bytes += Buffer.byteLength(source, "utf8");
    if (bytes > limits.maximumBytes) throw new Error("The generated CommonJS closure exceeded its byte bound.");
    visited.add(modulePath);
    for (const specifier of parseCommonJsEdges(modulePath, source)) {
      edges += 1;
      if (edges > limits.maximumEdges) throw new Error("The generated CommonJS closure exceeded its edge bound.");
      if (COMMONJS_BUILTINS.has(specifier)) continue;
      if (isUnsafeCommonJsAbsoluteSpecifier(specifier)) {
        throw new Error("A generated CommonJS module contains an absolute module edge.");
      }
      if (isCommonJsRelativeSpecifier(specifier)) {
        const target = resolveLocal(modulePath, specifier);
        if (!visited.has(target)) queue.push(target);
        continue;
      }
      const packageName = commonJsExternalPackageName(specifier);
      if (expectedHostExternals.has(specifier)) hostExternals.add(specifier);
      else if (expectedPackagedExternals.has(specifier)) packagedExternals.add(specifier);
      else {
        throw new Error(
          `The generated CommonJS closure contains unknown external package ${JSON.stringify(packageName)}.`
        );
      }
    }
  }
  assertExactCommonJsExternals("host", expectedHostExternals, hostExternals);
  assertExactCommonJsExternals("packaged", expectedPackagedExternals, packagedExternals);
  return Object.freeze({
    entrypoint,
    hostExternals: Object.freeze([...hostExternals].sort()),
    modules: Object.freeze([...visited].sort()),
    packagedExternals: Object.freeze([...packagedExternals].sort())
  });
}

function parseCommonJsEdges(modulePath, source) {
  const syntax = ts.createSourceFile(modulePath, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
  if (syntax.parseDiagnostics.length > 0) throw new Error("A generated CommonJS module is not valid JavaScript.");
  const createRequirePolicy = collectCreateRequirePolicy(syntax);
  const edges = [];
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isExportDeclaration(node) ||
      ts.isExportAssignment(node)
    ) {
      throw new Error("A generated CommonJS module contains unexpected module syntax.");
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        throw new Error("A generated CommonJS module contains a dynamic import.");
      }
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "eval" || node.expression.text === "Function")
      ) {
        throw new Error("A generated CommonJS module contains dynamic code evaluation.");
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === "require") {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) {
          throw new Error("A generated CommonJS module contains a dynamic require.");
        }
        const specifier = node.arguments[0].text;
        if (specifier.length === 0 || Buffer.byteLength(specifier, "utf8") > 1_024) {
          throw new Error("A generated CommonJS module contains an invalid module specifier.");
        }
        edges.push(specifier);
      }
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
      throw new Error("A generated CommonJS module contains dynamic code evaluation.");
    }
    if (ts.isIdentifier(node) && (node.text === "eval" || node.text === "Function")) {
      throw new Error("A generated CommonJS module contains dynamic code evaluation.");
    }
    if (ts.isIdentifier(node) && node.text === "require" && !isDirectCommonJsRequireIdentifier(node)) {
      throw new Error("A generated CommonJS module contains an indirect require.");
    }
    const loaderProperty = commonJsStaticPropertyName(node);
    if (loaderProperty !== undefined && COMMONJS_FORBIDDEN_LOADER_PROPERTIES.has(loaderProperty)) {
      throw new Error("A generated CommonJS module contains an indirect require or evaluation edge.");
    }
    if (ts.isIdentifier(node) && node.text === "Reflect") {
      throw new Error("A generated CommonJS module contains reflective dynamic access.");
    }
    if (isCommonJsLoaderModuleIdentifier(node) && !isReviewedCommonJsModuleIdentifier(node)) {
      throw new Error("A generated CommonJS module contains an unreviewed module-loader reference.");
    }
    assertCreateRequireNode(node, createRequirePolicy);
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return edges;
}

const COMMONJS_FORBIDDEN_LOADER_PROPERTIES = new Set(["require", "eval", "_load", "getBuiltinModule"]);

function commonJsStaticPropertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node)) return undefined;
  return staticStringValue(node.argumentExpression);
}

function staticStringValue(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticStringValue(node.left);
    const right = staticStringValue(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
  return undefined;
}

function isReviewedCommonJsModuleIdentifier(node) {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return parent.name.text === "exports";
  }
  return (
    ts.isPropertyAccessExpression(parent) &&
    parent.name === node &&
    ts.isPropertyAccessExpression(parent.parent) &&
    parent.parent.expression === parent &&
    parent.parent.name.text === "exports"
  );
}

function isCommonJsLoaderModuleIdentifier(node) {
  if (!ts.isIdentifier(node) || node.text !== "module") return false;
  const parent = node.parent;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node)
  ) {
    return false;
  }
  const functionScope = nearestCommonJsFunctionScope(node);
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (commonJsScopeDirectlyDeclaresModule(scope, functionScope)) return false;
    if (scope === functionScope) break;
  }
  return true;
}

function nearestCommonJsFunctionScope(node) {
  for (let scope = node.parent; scope !== undefined; scope = scope.parent) {
    if (ts.isSourceFile(scope) || ts.isFunctionLike(scope)) return scope;
  }
  return undefined;
}

function commonJsScopeDirectlyDeclaresModule(scope, functionScope) {
  if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) => bindingNameContainsModule(parameter.name))) {
    return true;
  }
  if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && scope !== functionScope) return false;
  const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (statement.declarationList.declarations.some((declaration) => bindingNameContainsModule(declaration.name))) {
      return true;
    }
  }
  return false;
}

function bindingNameContainsModule(name) {
  if (ts.isIdentifier(name)) return name.text === "module";
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameContainsModule(element.name));
}

function isDirectCommonJsRequireIdentifier(node) {
  const parent = node.parent;
  return (
    ts.isCallExpression(parent) &&
    parent.expression === node &&
    parent.arguments.length === 1 &&
    ts.isStringLiteral(parent.arguments[0])
  );
}

function collectCreateRequirePolicy(syntax) {
  const declarations = new Map();
  const factoryNames = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isCallExpression(node.initializer)
    ) {
      const factoryName = compiledCreateRequireFactoryName(node.initializer);
      if (factoryName !== undefined) {
        const declarationList = node.parent;
        if (
          !ts.isVariableDeclarationList(declarationList) ||
          (declarationList.flags & ts.NodeFlags.Const) === 0 ||
          node.initializer.arguments.length !== 1 ||
          declarations.has(node.name.text)
        ) {
          throw new Error("A generated CommonJS createRequire binding is malformed.");
        }
        declarations.set(node.name.text, node.name);
        factoryNames.add(factoryName);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return Object.freeze({ declarations, factoryNames });
}

function compiledCreateRequireFactoryName(call) {
  let expression = call.expression;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.CommaToken ||
    !ts.isNumericLiteral(expression.left) ||
    expression.left.text !== "0"
  ) {
    return undefined;
  }
  let factory = expression.right;
  while (ts.isParenthesizedExpression(factory)) factory = factory.expression;
  return ts.isPropertyAccessExpression(factory) &&
    ts.isIdentifier(factory.expression) &&
    factory.name.text === "createRequire"
    ? factory.name
    : undefined;
}

function assertCreateRequireNode(node, policy) {
  if (ts.isIdentifier(node) && node.text === "createRequire" && !policy.factoryNames.has(node)) {
    throw new Error("A generated CommonJS module contains an untracked createRequire factory.");
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression) &&
    node.argumentExpression.text === "createRequire"
  ) {
    throw new Error("A generated CommonJS module contains an indirect createRequire factory.");
  }
  if (!ts.isIdentifier(node)) return;
  const declaration = policy.declarations.get(node.text);
  if (declaration === undefined || node === declaration) return;
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    throw new Error("A generated CommonJS createRequire result escapes its reviewed use.");
  }
  if (
    parent.name.text === "resolve" &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent &&
    parent.parent.arguments.length === 1
  ) {
    return;
  }
  if (
    parent.name.text === "cache" &&
    ts.isElementAccessExpression(parent.parent) &&
    parent.parent.expression === parent &&
    parent.parent.argumentExpression !== undefined
  ) {
    return;
  }
  throw new Error("A generated CommonJS createRequire result uses an unreviewed loading surface.");
}

function normalizeCommonJsPolicy(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Generated CommonJS closure reconciliation requires one options object.");
  }
  const expectedHostExternals = normalizeCommonJsExternalSet(options.expectedHostExternals, "host");
  const expectedPackagedExternals = normalizeCommonJsExternalSet(options.expectedPackagedExternals, "packaged");
  for (const name of expectedHostExternals) {
    if (expectedPackagedExternals.has(name)) {
      throw new Error("Generated CommonJS host and packaged external sets must not overlap.");
    }
  }
  return Object.freeze({
    expectedHostExternals,
    expectedPackagedExternals,
    limits: normalizeCommonJsLimits(options.limits)
  });
}

function normalizeCommonJsExternalSet(value, label) {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`Generated CommonJS ${label} externals must be one bounded array.`);
  }
  const result = new Set();
  for (const name of value) {
    if (typeof name !== "string" || commonJsExternalPackageName(name) !== name || result.has(name)) {
      throw new Error(`Generated CommonJS ${label} externals contain an invalid package name.`);
    }
    result.add(name);
  }
  return result;
}

function normalizeCommonJsLimits(value) {
  const limits = value === undefined ? COMMONJS_DEFAULT_LIMITS : value;
  if (
    !limits ||
    typeof limits !== "object" ||
    Array.isArray(limits) ||
    !Number.isSafeInteger(limits.maximumModules) ||
    limits.maximumModules <= 0 ||
    limits.maximumModules > 4_096 ||
    !Number.isSafeInteger(limits.maximumEdges) ||
    limits.maximumEdges <= 0 ||
    limits.maximumEdges > 65_536 ||
    !Number.isSafeInteger(limits.maximumFileBytes) ||
    limits.maximumFileBytes <= 0 ||
    limits.maximumFileBytes > 32 * 1024 * 1024 ||
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < limits.maximumFileBytes ||
    limits.maximumBytes > 256 * 1024 * 1024
  ) {
    throw new Error("Generated CommonJS closure reconciliation requires fixed bounded limits.");
  }
  return Object.freeze({
    maximumBytes: limits.maximumBytes,
    maximumEdges: limits.maximumEdges,
    maximumFileBytes: limits.maximumFileBytes,
    maximumModules: limits.maximumModules
  });
}

function normalizeCommonJsModules(rawModules, limits) {
  if (!rawModules || typeof rawModules[Symbol.iterator] !== "function") {
    throw new Error("Generated CommonJS closure reconciliation requires an iterable module map.");
  }
  const modules = new Map();
  let bytes = 0;
  for (const item of rawModules) {
    if (!Array.isArray(item) || item.length !== 2) {
      throw new Error("A generated CommonJS module-map entry is malformed.");
    }
    const path = normalizeCommonJsModulePath(item[0], "module-map path");
    if (modules.has(path)) throw new Error("The generated CommonJS module map contains a duplicate path.");
    const source = Buffer.isBuffer(item[1]) ? decodeCommonJsUtf8(item[1]) : item[1];
    if (typeof source !== "string") throw new Error("A generated CommonJS module-map source is malformed.");
    const size = Buffer.byteLength(source, "utf8");
    if (size <= 0 || size > limits.maximumFileBytes) {
      throw new Error("A generated CommonJS module-map source exceeds its file bound.");
    }
    bytes += size;
    if (modules.size >= limits.maximumModules || bytes > limits.maximumBytes) {
      throw new Error("The generated CommonJS module map exceeded its fixed bounds.");
    }
    modules.set(path, source);
  }
  return modules;
}

function resolveCommonJsMappedModule(modules, requested) {
  const matches = commonJsModuleCandidates(requested).filter((candidate) => modules.has(candidate));
  if (matches.length !== 1) throw new Error("A generated CommonJS local edge is unresolved or ambiguous.");
  return matches[0];
}

function resolveCommonJsFileModule(root, requested, maximumFileBytes, pinReceipt) {
  const matches = [];
  for (const candidate of commonJsModuleCandidates(requested)) {
    const absolute = resolve(root, ...candidate.split("/"));
    try {
      const canonical = commonJsCanonicalModulePath(root, absolute, "local module edge");
      const receipt = commonJsModuleReceipt(canonical, maximumFileBytes);
      matches.push(Object.freeze({ candidate, receipt }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (matches.length !== 1) throw new Error("A generated CommonJS local edge is unresolved or ambiguous.");
  const path = resolve(root, ...matches[0].candidate.split("/"));
  assertPinnedCommonJsModule(path, matches[0].receipt, maximumFileBytes);
  pinReceipt(path, matches[0].receipt);
  return matches[0].candidate;
}

function commonJsModuleCandidates(requested) {
  if (requested.endsWith(".js")) return Object.freeze([requested]);
  return Object.freeze([`${requested}.js`, `${requested}/index.js`]);
}

function resolveCommonJsLocalPath(fromModule, specifier) {
  const requested = posix.normalize(posix.join(posix.dirname(fromModule), specifier));
  if (requested === ".." || requested.startsWith("../") || requested.startsWith("/")) {
    throw new Error("A generated CommonJS local edge escapes its closure root.");
  }
  return normalizeCommonJsRequestedPath(requested);
}

function normalizeCommonJsRequestedPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.endsWith("/")
  ) {
    throw new Error("The generated CommonJS local module edge is invalid.");
  }
  return value;
}

function normalizeCommonJsModulePath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.includes("\\") ||
    posix.isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    !value.endsWith(".js")
  ) {
    throw new Error(`The generated CommonJS ${label} is invalid.`);
  }
  return value;
}

function commonJsExternalPackageName(specifier) {
  if (typeof specifier !== "string" || specifier.length === 0 || specifier.includes("\\")) return undefined;
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) {
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] || undefined;
}

function isCommonJsRelativeSpecifier(specifier) {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

function isUnsafeCommonJsAbsoluteSpecifier(specifier) {
  return (
    isAbsolute(specifier) ||
    /^[A-Za-z]:[\\/]/u.test(specifier) ||
    specifier.startsWith("file:") ||
    specifier.startsWith("/")
  );
}

function assertExactCommonJsExternals(label, expected, actual) {
  if (expected.size !== actual.size || [...expected].some((name) => !actual.has(name))) {
    throw new Error(`The generated CommonJS closure has missing or stale expected ${label} externals.`);
  }
}

function commonJsCanonicalModulePath(root, path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path || !commonJsContainedBy(root, path)) {
    throw new Error(`The generated CommonJS ${label} escapes its closure root.`);
  }
  let canonical;
  try {
    canonical = realpathSync.native(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw new Error(`The generated CommonJS ${label} is not a canonical regular file.`, { cause: error });
  }
  if (canonical !== path || !commonJsContainedBy(root, canonical)) {
    throw new Error(`The generated CommonJS ${label} contains or traverses a link.`);
  }
  return canonical;
}

function commonJsRelativeModulePath(root, path) {
  return normalizeCommonJsModulePath(relative(root, path).split(sep).join("/"), "entrypoint");
}

function commonJsContainedBy(root, path) {
  const fromRoot = relative(root, path);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function readPinnedCommonJsModule(path, maximumBytes) {
  const captured = withCommonJsModuleDescriptor(path, maximumBytes, (descriptor, opened) => {
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error("A generated CommonJS module ended before its pinned size.");
      }
      offset += count;
    }
    return bytes;
  });
  return Object.freeze({ receipt: captured.receipt, source: decodeCommonJsUtf8(captured.value) });
}

function commonJsModuleReceipt(path, maximumBytes) {
  return withCommonJsModuleDescriptor(path, maximumBytes, () => undefined).receipt;
}

function assertPinnedCommonJsModule(path, receipt, maximumBytes) {
  const current = commonJsModuleReceipt(path, maximumBytes);
  if (!isDeepStrictEqual(receipt, current)) {
    throw new Error("A generated CommonJS module changed during reconciliation.");
  }
}

function withCommonJsModuleDescriptor(path, maximumBytes, inspect) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_CLOEXEC ?? 0)
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const namedBefore = lstatSync(path, { bigint: true });
    assertRegularCommonJsModule(opened, maximumBytes);
    assertRegularCommonJsModule(namedBefore, maximumBytes);
    const receipt = commonJsFileReceipt(opened);
    if (!isDeepStrictEqual(receipt, commonJsFileReceipt(namedBefore))) {
      throw new Error("A generated CommonJS module path changed.");
    }
    const value = inspect(descriptor, opened);
    const completed = commonJsFileReceipt(fstatSync(descriptor, { bigint: true }));
    const namedAfter = commonJsFileReceipt(lstatSync(path, { bigint: true }));
    if (!isDeepStrictEqual(receipt, completed) || !isDeepStrictEqual(receipt, namedAfter)) {
      throw new Error("A generated CommonJS module changed while it was inspected.");
    }
    return Object.freeze({ receipt, value });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertRegularCommonJsModule(metadata, maximumBytes) {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes) ||
    metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("A generated CommonJS module must be one bounded single-link regular file.");
  }
}

function commonJsFileReceipt(metadata) {
  return Object.freeze({
    birthtimeNs: metadata.birthtimeNs,
    ctimeNs: metadata.ctimeNs,
    dev: metadata.dev,
    gid: metadata.gid,
    ino: metadata.ino,
    mode: metadata.mode,
    mtimeNs: metadata.mtimeNs,
    nlink: metadata.nlink,
    size: metadata.size,
    uid: metadata.uid
  });
}

function decodeCommonJsUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error("A generated CommonJS module must contain valid UTF-8.", { cause: error });
  }
}

export function stageRemoteWorkspaceExactFile(source, destination, mode = 0o600, rawReceiptPolicy = {}) {
  const sourcePath = canonicalRegularPath(source, "source");
  const stagedPath = boundedAbsolutePath(destination, "staged");
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error("Remote SSH exact-file staging requires one bounded permissions mode.");
  }
  const receiptPolicy = normalizeExactFileReceiptPolicy(rawReceiptPolicy);
  const sourceReceipt = captureRemoteWorkspaceFileReceipt(sourcePath, receiptPolicy);
  copyFileSync(sourcePath, stagedPath, constants.COPYFILE_EXCL);
  chmodSync(stagedPath, mode);
  assertRemoteWorkspaceFileReceipt(sourcePath, sourceReceipt, receiptPolicy);
  const stagedReceipt = captureRemoteWorkspaceFileReceipt(stagedPath, receiptPolicy);
  if (
    sourceReceipt.size !== stagedReceipt.size ||
    sourceReceipt.sha256 !== stagedReceipt.sha256 ||
    permissions(stagedReceipt) !== mode
  ) {
    throw new Error("A Remote SSH exact-file stage did not preserve its pinned source bytes and mode.");
  }
  return Object.freeze({ sourcePath, sourceReceipt, stagedPath, stagedReceipt, mode, receiptPolicy });
}

export function assertRemoteWorkspaceExactFileStage(stage) {
  if (
    !stage ||
    typeof stage !== "object" ||
    typeof stage.sourcePath !== "string" ||
    typeof stage.stagedPath !== "string" ||
    !Number.isInteger(stage.mode) ||
    !stage.receiptPolicy ||
    typeof stage.receiptPolicy !== "object"
  ) {
    throw new Error("The Remote SSH exact-file stage receipt is malformed.");
  }
  const receiptPolicy = normalizeExactFileReceiptPolicy(stage.receiptPolicy);
  const sourceReceipt = assertRemoteWorkspaceFileReceipt(stage.sourcePath, stage.sourceReceipt, receiptPolicy);
  const stagedReceipt = assertRemoteWorkspaceFileReceipt(stage.stagedPath, stage.stagedReceipt, receiptPolicy);
  if (
    sourceReceipt.size !== stagedReceipt.size ||
    sourceReceipt.sha256 !== stagedReceipt.sha256 ||
    permissions(stagedReceipt) !== stage.mode
  ) {
    throw new Error("A Remote SSH exact-file stage changed after its provenance was pinned.");
  }
  return stage;
}

function normalizeExactFileReceiptPolicy(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    !Object.keys(raw).every((key) => key === "maximumBytes") ||
    (raw.maximumBytes !== undefined && (!Number.isSafeInteger(raw.maximumBytes) || raw.maximumBytes <= 0))
  ) {
    throw new Error("Remote SSH exact-file staging requires one bounded receipt policy.");
  }
  return raw.maximumBytes === undefined ? Object.freeze({}) : Object.freeze({ maximumBytes: raw.maximumBytes });
}

export function stageRemoteWorkspaceTree(source, destination, rawBounds) {
  const sourceRoot = canonicalDirectoryPath(source, "source tree");
  const stagedRoot = boundedAbsolutePath(destination, "staged tree");
  const bounds = normalizeTreeBounds(rawBounds);
  if (isSameOrContained(sourceRoot, stagedRoot) || isSameOrContained(stagedRoot, sourceRoot)) {
    throw new Error("Remote SSH tree staging requires independent source and destination roots.");
  }
  const sourceManifest = captureRemoteWorkspaceTreeManifest(sourceRoot, bounds);
  mkdirSync(dirname(stagedRoot), { recursive: true, mode: 0o700 });
  cpSync(sourceRoot, stagedRoot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  const sourceAfter = captureRemoteWorkspaceTreeManifest(sourceRoot, bounds);
  const stagedManifest = captureRemoteWorkspaceTreeManifest(stagedRoot, bounds);
  if (
    !isDeepStrictEqual(sourceAfter, sourceManifest) ||
    !isDeepStrictEqual(treeContents(sourceManifest), treeContents(stagedManifest))
  ) {
    throw new Error(`The bounded ${bounds.label} changed while it was staged.`);
  }
  return Object.freeze({ sourceRoot, sourceManifest, stagedRoot, stagedManifest, bounds });
}

export function assertRemoteWorkspaceTreeStage(stage) {
  if (
    !stage ||
    typeof stage !== "object" ||
    typeof stage.sourceRoot !== "string" ||
    typeof stage.stagedRoot !== "string"
  ) {
    throw new Error("The Remote SSH tree-stage receipt is malformed.");
  }
  const bounds = normalizeTreeBounds(stage.bounds);
  const sourceManifest = captureRemoteWorkspaceTreeManifest(stage.sourceRoot, bounds);
  const stagedManifest = captureRemoteWorkspaceTreeManifest(stage.stagedRoot, bounds);
  if (
    !isDeepStrictEqual(sourceManifest, stage.sourceManifest) ||
    !isDeepStrictEqual(stagedManifest, stage.stagedManifest) ||
    !isDeepStrictEqual(treeContents(sourceManifest), treeContents(stagedManifest))
  ) {
    throw new Error(`The bounded ${bounds.label} changed after its provenance was pinned.`);
  }
  return stage;
}

export function captureRemoteWorkspaceTreeManifest(root, rawBounds) {
  const canonicalRoot = canonicalDirectoryPath(root, "tree");
  const bounds = normalizeTreeBounds(rawBounds);
  const files = [];
  const links = [];
  const directories = [];
  const queue = [canonicalRoot];
  let bytes = 0;
  let entries = 0;
  while (queue.length > 0) {
    const directory = queue.shift();
    const before = directoryReceipt(directory);
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of children) {
      entries += 1;
      if (entries > bounds.maximumFiles) {
        throw new Error(`${bounds.label} exceeded its fixed entry bound.`);
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path, { bigint: true });
      if (metadata.isSymbolicLink()) {
        const target = readlinkSync(path);
        const targetReceipt = validateTreeSymlink(canonicalRoot, path, target, metadata, bounds);
        links.push(Object.freeze({ path: relative(canonicalRoot, path), ...targetReceipt }));
      }
      if (metadata.isDirectory()) {
        queue.push(path);
      } else if (metadata.isFile()) {
        const receipt = captureRemoteWorkspaceFileReceipt(path, {
          allowEmpty: true,
          maximumBytes: bounds.maximumFileBytes
        });
        if (receipt.size > BigInt(bounds.maximumFileBytes)) {
          throw new Error(`${bounds.label} contains an oversized file.`);
        }
        bytes += Number(receipt.size);
        if (bytes > bounds.maximumBytes) {
          throw new Error(`${bounds.label} exceeded its fixed byte bound.`);
        }
        files.push(Object.freeze({ path: relative(canonicalRoot, path), receipt }));
      } else if (!metadata.isSymbolicLink()) {
        throw new Error(`${bounds.label} contains an unsafe file.`);
      }
    }
    const after = directoryReceipt(directory);
    if (!isDeepStrictEqual(before, after)) {
      throw new Error(`${bounds.label} changed while its directory entries were captured.`);
    }
    directories.push(Object.freeze({ path: relative(canonicalRoot, directory) || ".", receipt: after }));
  }
  files.sort(compareManifestPath);
  links.sort(compareManifestPath);
  directories.sort(compareManifestPath);
  return Object.freeze({
    bytes,
    files: Object.freeze(files),
    links: Object.freeze(links),
    directories: Object.freeze(directories)
  });
}

function normalizeTreeBounds(value) {
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.label !== "string" ||
    value.label.length <= 0 ||
    value.label.length > 128 ||
    !Number.isSafeInteger(value.maximumFiles) ||
    !Number.isSafeInteger(value.maximumBytes) ||
    !Number.isSafeInteger(value.maximumFileBytes) ||
    value.maximumFiles <= 0 ||
    value.maximumFiles > MAXIMUM_TREE_FILES ||
    value.maximumBytes <= 0 ||
    value.maximumBytes > MAXIMUM_TREE_BYTES ||
    value.maximumFileBytes <= 0 ||
    value.maximumFileBytes > value.maximumBytes ||
    (value.allowInternalSymlinks !== undefined && typeof value.allowInternalSymlinks !== "boolean") ||
    (value.allowedAbsoluteSymlinkRoots !== undefined &&
      (!Array.isArray(value.allowedAbsoluteSymlinkRoots) ||
        value.allowedAbsoluteSymlinkRoots.length > 8 ||
        value.allowedAbsoluteSymlinkRoots.some(
          (path, index, paths) =>
            typeof path !== "string" ||
            !isAbsolute(path) ||
            resolve(path) !== path ||
            realpathSync(path) !== path ||
            paths.indexOf(path) !== index
        )))
  ) {
    throw new Error("Remote SSH tree staging requires fixed bounded manifest limits.");
  }
  return Object.freeze({
    label: value.label,
    maximumFiles: value.maximumFiles,
    maximumBytes: value.maximumBytes,
    maximumFileBytes: value.maximumFileBytes,
    allowInternalSymlinks: value.allowInternalSymlinks === true,
    allowedAbsoluteSymlinkRoots: Object.freeze([...(value.allowedAbsoluteSymlinkRoots ?? [])])
  });
}

function treeContents(manifest) {
  return Object.freeze({
    bytes: manifest.bytes,
    directories: Object.freeze(manifest.directories.map((entry) => Object.freeze({ path: entry.path }))),
    links: Object.freeze(
      manifest.links.map((entry) =>
        Object.freeze({
          path: entry.path,
          target: entry.target,
          resolvedTarget: entry.resolvedTarget
        })
      )
    ),
    files: Object.freeze(
      manifest.files.map((entry) =>
        Object.freeze({
          path: entry.path,
          size: entry.receipt.size,
          sha256: entry.receipt.sha256,
          permissions: permissions(entry.receipt)
        })
      )
    )
  });
}

function validateTreeSymlink(root, path, target, metadata, bounds) {
  if (
    typeof target !== "string" ||
    target.length <= 0 ||
    target.length > 16_384 ||
    /[\0\r\n]/u.test(target) ||
    metadata.nlink !== 1n
  ) {
    throw new Error(`${bounds.label} contains an unsafe symbolic link.`);
  }
  const lexicalTarget = resolve(dirname(path), target);
  const internal = isSameOrContained(root, lexicalTarget);
  if (!internal && !isAbsolute(target)) {
    throw new Error(`${bounds.label} contains an escaping relative symbolic link.`);
  }
  if (internal && !bounds.allowInternalSymlinks) {
    throw new Error(`${bounds.label} contains a symbolic link.`);
  }
  const resolvedTarget = realpathSync(path);
  if (!isSameOrContained(root, resolvedTarget)) {
    const externalRoot = bounds.allowedAbsoluteSymlinkRoots.find((candidate) =>
      isSameOrContained(candidate, resolvedTarget)
    );
    const targetMetadata = lstatSync(resolvedTarget, { bigint: true });
    if (
      !externalRoot ||
      targetMetadata.isSymbolicLink() ||
      (!targetMetadata.isFile() && !targetMetadata.isDirectory()) ||
      targetMetadata.uid !== 0n ||
      Number(targetMetadata.mode & 0o022n) !== 0
    ) {
      throw new Error(`${bounds.label} contains an untrusted absolute symbolic link.`);
    }
  }
  return Object.freeze({
    target,
    resolvedTarget:
      internal && isSameOrContained(root, resolvedTarget) ? relative(root, resolvedTarget) : resolvedTarget,
    receipt: Object.freeze({
      dev: metadata.dev,
      ino: metadata.ino,
      mode: metadata.mode,
      nlink: metadata.nlink,
      uid: metadata.uid,
      gid: metadata.gid,
      size: metadata.size,
      mtimeNs: metadata.mtimeNs,
      ctimeNs: metadata.ctimeNs,
      birthtimeNs: metadata.birthtimeNs
    })
  });
}

function directoryReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Remote SSH tree staging requires one regular directory tree.");
  }
  const canonical = realpathSync(path);
  if (canonical !== path) {
    throw new Error("Remote SSH tree staging requires canonical directory paths.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    nlink: metadata.nlink,
    uid: metadata.uid,
    gid: metadata.gid,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
    birthtimeNs: metadata.birthtimeNs
  });
}

function canonicalRegularPath(path, label) {
  const bounded = boundedAbsolutePath(path, label);
  const canonical = realpathSync(bounded);
  const metadata = lstatSync(bounded);
  if (canonical !== bounded || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH exact-file staging requires one canonical regular ${label}.`);
  }
  return canonical;
}

function canonicalDirectoryPath(path, label) {
  const bounded = boundedAbsolutePath(path, label);
  const canonical = realpathSync(bounded);
  const metadata = lstatSync(bounded);
  if (canonical !== bounded || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Remote SSH tree staging requires one canonical regular ${label}.`);
  }
  return canonical;
}

function boundedAbsolutePath(path, label) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length <= 0 || path.length > 16_384) {
    throw new Error(`Remote SSH staging requires one bounded absolute ${label} path.`);
  }
  return resolve(path);
}

function isSameOrContained(parent, candidate) {
  const relation = relative(parent, candidate);
  return relation.length === 0 || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function permissions(receipt) {
  return Number(receipt.mode & RECEIPT_PERMISSIONS);
}

function compareManifestPath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}
