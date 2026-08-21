import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
export const CI_CLASSIFIER_OUTPUTS = Object.freeze([
  "r_contract_required",
  "canonical_editor_required",
  "visual_accessibility_required",
  "windows_unique_required"
]);

const SELF_SELECTING_PATHS = new Set([
  ".node-version",
  "package.json",
  "package-lock.json",
  "python/pyproject.toml",
  "scripts/ci-path-classification.mjs",
  "scripts/ci-workflow.test.mjs",
  "scripts/fixtures/ci-capabilities.json",
  "scripts/require-ci-results.mjs",
  "scripts/r-dependency-lock.mjs",
  "scripts/r-dependency-lock.test.mjs"
]);
const DOCUMENTATION_ROOTS = new Set(["AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]);
const R_CONTRACT_PATHS = new Set([
  "protocol/openwrangler.v2.schema.json",
  "python/openwrangler_runtime/protocol.py",
  "python/openwrangler_runtime/server.py",
  "python/openwrangler_runtime/session.py",
  "schemas/operation-catalog.v1.json",
  "src/shared/operationCatalog.generated.ts",
  "python/openwrangler_runtime/operation_catalog_generated.py"
]);
const WINDOWS_UNIQUE_PATHS = new Set([
  "python/openwrangler_runtime/dependency_guard.py",
  "python/openwrangler_runtime/engines/base.py",
  "python/openwrangler_runtime/engines/duckdb_engine.py",
  "python/openwrangler_runtime/engines/duckdb_export_filesystem.py",
  "python/openwrangler_runtime/error_causality.py",
  "python/openwrangler_runtime/export_target.py",
  "python/openwrangler_runtime/process_supervision.py",
  "python/openwrangler_runtime/protocol.py",
  "python/openwrangler_runtime/server.py",
  "python/openwrangler_runtime/session.py",
  "python/openwrangler_runtime/windows_file_handle.py",
  "python/tests/test_dependency_guard.py",
  "python/tests/test_dependency_guard_exact_version.py",
  "python/tests/test_duckdb_export_filesystem.py",
  "python/tests/test_export_target.py",
  "python/tests/test_session_editing.py",
  "scripts/windows-job-supervisor.native.test.mjs",
  "scripts/windows-job-supervisor.ps1",
  "src/extension/dependencyInstaller.ts",
  "src/extension/files/safeFileExport.ts",
  "src/extension/files/safePythonDataExport.ts",
  "src/extension/processShutdown.ts",
  "src/extension/pythonDependencyState.ts",
  "src/extension/pythonEnvironment.ts",
  "src/extension/pythonEnvironmentModel.ts",
  "src/test/dependencyInstaller.unit.test.ts",
  "src/test/extensionHost/index.ts",
  "src/test/nativeViewExportCommands.unit.test.ts",
  "src/test/processShutdown.unit.test.ts",
  "src/test/pythonBridgeDataExport.unit.test.ts",
  "src/test/pythonEnvironment.unit.test.ts",
  "src/test/safeFileExport.unit.test.ts",
  "src/test/safeFileExportHardlink.unit.test.ts",
  "src/test/safePythonDataExport.unit.test.ts"
]);

function canonicalPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0") || path.startsWith("/")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function documentationOnlyPath(path) {
  return (
    DOCUMENTATION_ROOTS.has(path) ||
    (path.startsWith("docs/") && !path.startsWith("docs/images/")) ||
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path.startsWith(".github/PULL_REQUEST_TEMPLATE/") ||
    path === ".github/PULL_REQUEST_TEMPLATE.md" ||
    path === ".github/pull_request_template.md"
  );
}

function selfSelectingPath(path) {
  return (
    SELF_SELECTING_PATHS.has(path) ||
    path.startsWith(".github/workflows/") ||
    path.startsWith(".github/actions/") ||
    path.startsWith(".github/dependabot") ||
    path.startsWith("r/dependencies/native-r-contract/") ||
    path.startsWith("scripts/toolchain") ||
    path.startsWith("scripts/validate")
  );
}

function rContractPath(path) {
  return (
    path.startsWith("r/") ||
    path.startsWith("src/extension/r/") ||
    /^src\/test\/.*(?:releasedR|rKernel|rContract|R[A-Z])/u.test(path) ||
    R_CONTRACT_PATHS.has(path) ||
    path.startsWith("scripts/run-r-contract-tests.") ||
    path.startsWith("scripts/generate-operation-catalog.")
  );
}

function visualAccessibilityPath(path) {
  return (
    path.startsWith("src/webviews/") ||
    path.startsWith("src/test/__snapshots__/") ||
    /^src\/test\/.*(?:webview|accessibility|axe|visual)/iu.test(path) ||
    path.startsWith("docs/images/") ||
    path.startsWith("media/") ||
    /^(scripts\/.*(?:webview|accessibility|axe|screenshot)|vite\.webview|tsconfig\.webview)/iu.test(path)
  );
}

function windowsUniquePath(path) {
  return (
    WINDOWS_UNIQUE_PATHS.has(path) ||
    path === ".github/workflows/cross-platform.yml" ||
    /^python\/(?:openwrangler_runtime|tests)\/.*(?:windows|reparse|hardlink|publication|process|dependency)/iu.test(
      path
    ) ||
    /^scripts\/.*(?:windows|job-supervisor|packaged-python-preflight)/iu.test(path)
  );
}

function canonicalEditorPath(path) {
  return (
    path === "package.json" ||
    path === "package-lock.json" ||
    path.startsWith("src/") ||
    path.startsWith("python/") ||
    path.startsWith("r/") ||
    path.startsWith("protocol/") ||
    path.startsWith("schemas/") ||
    path.startsWith("fixtures/") ||
    path.startsWith("scripts/packaged-") ||
    path.startsWith("scripts/editor-") ||
    path.startsWith("scripts/run-extension-") ||
    /^tsconfig(?:\.[a-z0-9-]+)?\.json$/u.test(path)
  );
}

function fullSelection() {
  return {
    rContractRequired: true,
    canonicalEditorRequired: true,
    visualAccessibilityRequired: true,
    windowsUniqueRequired: true
  };
}

export function classifyCiChange({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  if (!["pull_request", "merge_group", "push", "schedule", "workflow_dispatch"].includes(eventName)) {
    throw new Error(`Unsupported CI event: ${eventName || "missing"}.`);
  }
  if (eventName !== "pull_request") return fullSelection();
  if (changedPaths.length === 0 || changedPaths.some((path) => !canonicalPath(path))) return fullSelection();
  if (changedPaths.some((path) => selfSelectingPath(path))) return fullSelection();

  const substantive = changedPaths.filter((path) => !documentationOnlyPath(path));
  if (substantive.length === 0) {
    return {
      rContractRequired: false,
      canonicalEditorRequired: false,
      visualAccessibilityRequired: false,
      windowsUniqueRequired: false
    };
  }
  const known = substantive.every(
    (path) =>
      rContractPath(path) || visualAccessibilityPath(path) || windowsUniquePath(path) || canonicalEditorPath(path)
  );
  if (!known) return fullSelection();
  return {
    rContractRequired: substantive.some((path) => rContractPath(path)),
    canonicalEditorRequired: substantive.some((path) => canonicalEditorPath(path)),
    visualAccessibilityRequired: substantive.some((path) => visualAccessibilityPath(path)),
    windowsUniqueRequired: substantive.some((path) => windowsUniquePath(path))
  };
}

export function parseChangedPathBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Changed paths must be provided as a Buffer.");
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new Error("The changed-path list must be NUL terminated.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index === start) throw new Error("The changed-path list contains an empty path.");
    paths.push(decoder.decode(buffer.subarray(start, index)));
    start = index + 1;
  }
  return paths;
}

export function sanitizedGitEnvironment(environment) {
  if (environment === null || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("Git environment must be one environment mapping.");
  }
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(environment).filter(([name, value]) => !/^git_/iu.test(name) && typeof value === "string")
    ),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_TERMINAL_PROMPT: "0"
  });
}

function readPullRequestPaths({ baseSha, headSha }) {
  if (!COMMIT_SHA.test(baseSha ?? "") || !COMMIT_SHA.test(headSha ?? "")) {
    throw new Error("Pull-request base and head revisions must be exact lowercase commit SHAs.");
  }
  return parseChangedPathBuffer(
    execFileSync(
      "git",
      [
        "--no-replace-objects",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-c",
        "core.useReplaceRefs=false",
        "diff",
        "--name-only",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "-z",
        baseSha,
        headSha,
        "--"
      ],
      {
        cwd: process.cwd(),
        encoding: "buffer",
        env: sanitizedGitEnvironment(process.env),
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"]
      }
    )
  );
}

export function resolvePullRequestClassificationRange({
  pullRequestBaseSha,
  pullRequestHeadSha,
  stackBaseSha,
  stackPosition,
  stackSize
}) {
  if (!COMMIT_SHA.test(pullRequestBaseSha ?? "") || !COMMIT_SHA.test(pullRequestHeadSha ?? "")) {
    throw new Error("Pull-request base and head revisions must be exact lowercase commit SHAs.");
  }

  const stackFields = [stackBaseSha, stackPosition, stackSize].map((value) => value ?? "");
  const presentStackFields = stackFields.filter((value) => value !== "").length;
  if (presentStackFields === 0) {
    return Object.freeze({
      baseSha: pullRequestBaseSha,
      headSha: pullRequestHeadSha,
      stackedEvent: false,
      stackPosition: null,
      stackSize: null,
      partialPrefix: false
    });
  }
  if (presentStackFields !== stackFields.length) {
    throw new Error("Stack classification requires an exact base SHA, position, and size together.");
  }
  if (!COMMIT_SHA.test(stackBaseSha) || !POSITIVE_INTEGER.test(stackPosition) || !POSITIVE_INTEGER.test(stackSize)) {
    throw new Error("Stack classification metadata is malformed.");
  }
  const position = Number.parseInt(stackPosition, 10);
  const size = Number.parseInt(stackSize, 10);
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(size) || position > size) {
    throw new Error("Stack classification position must be within the exact stack size.");
  }
  return Object.freeze({
    baseSha: stackBaseSha,
    headSha: pullRequestHeadSha,
    stackedEvent: true,
    stackPosition: position,
    stackSize: size,
    partialPrefix: position < size
  });
}

function main(environment) {
  const eventName = environment.CI_EVENT_NAME;
  const range =
    eventName === "pull_request"
      ? resolvePullRequestClassificationRange({
          pullRequestBaseSha: environment.CI_BASE_SHA,
          pullRequestHeadSha: environment.CI_HEAD_SHA,
          stackBaseSha: environment.CI_STACK_BASE_SHA,
          stackPosition: environment.CI_STACK_POSITION,
          stackSize: environment.CI_STACK_SIZE
        })
      : undefined;
  const changedPaths = range ? readPullRequestPaths(range) : [];
  const classification = classifyCiChange({ eventName, changedPaths });
  if (range) {
    process.stdout.write(
      `CI classification range: base=${range.baseSha} head=${range.headSha} stacked=${range.stackedEvent} ` +
        `position=${range.stackPosition ?? "ordinary"} size=${range.stackSize ?? "ordinary"} ` +
        `partial-prefix=${range.partialPrefix}\n`
    );
  }
  if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    environment.GITHUB_OUTPUT,
    [
      `r_contract_required=${classification.rContractRequired}`,
      `canonical_editor_required=${classification.canonicalEditorRequired}`,
      `visual_accessibility_required=${classification.visualAccessibilityRequired}`,
      `windows_unique_required=${classification.windowsUniqueRequired}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CI path classification failed."}\n`);
    process.exitCode = 1;
  }
}
