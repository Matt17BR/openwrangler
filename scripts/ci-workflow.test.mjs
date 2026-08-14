import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { load as parseYaml } from "js-yaml";
import ts from "typescript";
import { loadConfigFromFile } from "vite";
import {
  BENCHMARK_HARNESS_PATHS,
  RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS,
  RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS,
  RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS,
  RELEASE_INFRASTRUCTURE_TEST_PATHS,
  classifyCiChange,
  isBenchmarkHarnessOnlyChangeSet,
  isDependencyLockOnlyChangeSet,
  isDocumentationOnlyChangeSet,
  isPackageOnlyChangeSet,
  isReleaseInfrastructureOnlyChangeSet,
  parseChangedPathBuffer,
  parsePullRequestDraft
} from "./ci-path-classification.mjs";
import {
  ALWAYS_REQUIRED_CI_JOBS,
  BENCHMARK_HARNESS_CI_JOBS,
  DEPENDENCY_LOCK_CI_JOBS,
  FULL_MATRIX_CI_JOBS,
  OPTIONAL_CI_JOB,
  PACKAGE_CI_JOBS,
  PRODUCT_CI_JOBS,
  REQUIRED_CI_JOBS,
  RELEASE_INFRASTRUCTURE_CI_JOBS,
  parseRequiredFlag,
  requireCiResults,
  resultEnvironmentKey
} from "./require-ci-results.mjs";
import { inspectDeferredDiagnosticFailures } from "./release-diagnostic-order.mjs";

const replaceablePullRequestWorkflows = [
  [".github/workflows/ci.yml", "ci-${{ github.event_name }}-${{ github.ref }}"],
  [".github/workflows/cross-platform.yml", "cross-platform-${{ github.event_name }}-${{ github.ref }}"],
  [".github/workflows/codeql.yml", "codeql-${{ github.event_name }}-${{ github.ref }}"]
];

const requiredPullRequestWorkflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/cross-platform.yml",
  ".github/workflows/codeql.yml"
];
const EXPECTED_BLOCKING_CI_JOBS = Object.freeze([
  "classify",
  "fast-feedback",
  "benchmark-harness",
  "contract-tests",
  "visual-accessibility",
  "production-audits",
  "dependency-lock-validation",
  "release-infrastructure",
  "canonical-vsix",
  "linux-packaged-editor",
  "coverage",
  "python-matrix",
  "native-r-contract",
  "extension-host"
]);
const SETUP_R_ACTION = "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const SETUP_R_DEPENDENCIES_ACTION = "r-lib/actions/setup-r-dependencies@d3c5be51b12e724e68f33216ca3c148b66d5f0b6";
const SCRIPT_TEST_GROUPS = Object.freeze(["workflow", "portable", "media", "native"]);
const CANONICAL_CI_IF =
  "${{ !cancelled() && github.event_name == 'pull_request' && needs.fast-feedback.result == 'success' && (needs.classify.result != 'success' || (needs.classify.outputs.lightweight_only != 'true' && needs.classify.outputs.benchmark_harness_only != 'true')) }}";
const CONTRACT_CI_IF =
  "${{ !cancelled() && github.event_name == 'pull_request' && needs.fast-feedback.result == 'success' && (needs.classify.result != 'success' || needs.classify.outputs.full_matrix_required != 'false') }}";
const FULL_CI_IF =
  "${{ !cancelled() && github.event_name == 'pull_request' && needs.fast-feedback.result == 'success' && needs.contract-tests.result == 'success' && (needs.classify.result != 'success' || needs.classify.outputs.full_matrix_required != 'false') }}";
const RELEASE_INFRASTRUCTURE_CI_IF =
  "${{ !cancelled() && github.event_name == 'pull_request' && needs.classify.result == 'success' && needs.fast-feedback.result == 'success' && needs.classify.outputs.release_infrastructure_only == 'true' && needs.classify.outputs.draft_pull_request == 'false' }}";
const MATRIX_CONTEXT_IF = "${{ !cancelled() }}";
const NON_MATRIX_CONTEXT_IF =
  "${{ needs.classify.result == 'success' && needs.classify.outputs.full_matrix_required == 'false' }}";
const SUBSTANTIVE_MATRIX_STEP_IF =
  "${{ needs.classify.result == 'success' && needs.classify.outputs.full_matrix_required == 'true' }}";
const CODEQL_NON_MATRIX_CONTEXT_IF =
  "${{ needs.classify.result == 'success' && needs.classify.outputs.full_matrix_required == 'false' && (needs.classify.outputs.release_infrastructure_only != 'true' || matrix.language == 'python') }}";
const CODEQL_SUBSTANTIVE_MATRIX_STEP_IF =
  "${{ needs.classify.result == 'success' && (needs.classify.outputs.full_matrix_required == 'true' || (needs.classify.outputs.release_infrastructure_only == 'true' && matrix.language == 'javascript-typescript')) }}";
const CLASSIFICATION_GATE_IF =
  "${{ needs.classify.result != 'success' || (needs.classify.outputs.benchmark_harness_only != 'true' && needs.classify.outputs.benchmark_harness_only != 'false') || (needs.classify.outputs.dependency_lock_only != 'true' && needs.classify.outputs.dependency_lock_only != 'false') || (needs.classify.outputs.documentation_only != 'true' && needs.classify.outputs.documentation_only != 'false') || (needs.classify.outputs.draft_pull_request != 'true' && needs.classify.outputs.draft_pull_request != 'false') || (needs.classify.outputs.lightweight_only != 'true' && needs.classify.outputs.lightweight_only != 'false') || (needs.classify.outputs.package_only != 'true' && needs.classify.outputs.package_only != 'false') || (needs.classify.outputs.release_infrastructure_only != 'true' && needs.classify.outputs.release_infrastructure_only != 'false') || (needs.classify.outputs.full_matrix_required != 'true' && needs.classify.outputs.full_matrix_required != 'false') || (needs.classify.outputs.lightweight_only == 'true' && needs.classify.outputs.documentation_only == 'false' && needs.classify.outputs.draft_pull_request == 'false') || (needs.classify.outputs.lightweight_only == 'false' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.documentation_only == 'true' && needs.classify.outputs.package_only == 'true') || (needs.classify.outputs.benchmark_harness_only == 'true' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.package_only == 'true' || needs.classify.outputs.dependency_lock_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.dependency_lock_only == 'true' && (needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.package_only == 'true')) || (needs.classify.outputs.release_infrastructure_only == 'true' && (needs.classify.outputs.benchmark_harness_only == 'true' || needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.package_only == 'true' || needs.classify.outputs.dependency_lock_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.full_matrix_required == 'true' && (needs.classify.outputs.benchmark_harness_only == 'true' || needs.classify.outputs.documentation_only == 'true' || needs.classify.outputs.package_only == 'true' || needs.classify.outputs.dependency_lock_only == 'true' || needs.classify.outputs.release_infrastructure_only == 'true' || needs.classify.outputs.draft_pull_request == 'true')) || (needs.classify.outputs.full_matrix_required == 'false' && needs.classify.outputs.benchmark_harness_only == 'false' && needs.classify.outputs.documentation_only == 'false' && needs.classify.outputs.package_only == 'false' && needs.classify.outputs.dependency_lock_only == 'false' && needs.classify.outputs.release_infrastructure_only == 'false' && needs.classify.outputs.draft_pull_request == 'false') }}";
const PRODUCT_PUSH_BRANCHES = ["main"];
const PROTECTED_PULL_REQUEST_BRANCHES = ["main"];
const PULL_REQUEST_ACTIVITY_TYPES = ["opened", "synchronize", "reopened", "ready_for_review", "converted_to_draft"];

const RELEASE_INFRASTRUCTURE_TEST_OWNER = Object.freeze({
  "scripts/candidate-acceptance-workflow.mjs": "scripts/candidate-acceptance-workflow.test.mjs",
  "scripts/canonical-release-assets.mjs": "scripts/verify-canonical-release-artifact.test.mjs",
  "scripts/create-canonical-release-artifact.mjs": "scripts/create-canonical-release-artifact.test.mjs",
  "scripts/download-canonical-github-release.mjs": "scripts/download-canonical-github-release.test.mjs",
  "scripts/github-release-publisher.mjs": "scripts/publish-github-stable-release.test.mjs",
  "scripts/marketplace-identity-profile.mjs": "scripts/marketplace-identity-profile.test.mjs",
  "scripts/marketplace-promotion-workflow.mjs": "scripts/marketplace-promotion-workflow.test.mjs",
  "scripts/marketplace-release-intake.mjs": "scripts/marketplace-release-intake.test.mjs",
  "scripts/open-vsx-promotion-workflow.mjs": "scripts/open-vsx-promotion-workflow.test.mjs",
  "scripts/package-current-channel.mjs": "scripts/package-current-channel.test.mjs",
  "scripts/prepare-stable-candidate-tag.mjs": "scripts/prepare-stable-candidate-tag.test.mjs",
  "scripts/preview-release-workflow.mjs": "scripts/release-readiness.test.mjs",
  "scripts/public-media-contract.mjs": "scripts/public-media-surfaces.test.mjs",
  "scripts/public-media-inventory.mjs": "scripts/public-media-surfaces.test.mjs",
  "scripts/public-media-surface-contract.mjs": "scripts/public-media-surfaces.test.mjs",
  "scripts/public-repository-metadata.mjs": "scripts/public-repository-metadata.test.mjs",
  "scripts/publish-github-preview-release.mjs": "scripts/verify-registry-release-artifact.test.mjs",
  "scripts/publish-github-stable-release.mjs": "scripts/publish-github-stable-release.test.mjs",
  "scripts/push-stable-release-tag.mjs": "scripts/push-stable-release-tag.test.mjs",
  "scripts/registry-release-source.mjs": "scripts/registry-release-source.test.mjs",
  "scripts/release-diagnostic-order.mjs": "scripts/candidate-acceptance-workflow.test.mjs",
  "scripts/release-documents.mjs": "scripts/release-readiness.test.mjs",
  "scripts/release-metadata.mjs": "scripts/release-readiness.test.mjs",
  "scripts/release-notes.mjs": "scripts/publish-github-stable-release.test.mjs",
  "scripts/release-readiness.mjs": "scripts/release-readiness.test.mjs",
  "scripts/release-tag-publisher.mjs": "scripts/push-stable-release-tag.test.mjs",
  "scripts/stable-release-workflow.mjs": "scripts/stable-release-workflow.test.mjs",
  "scripts/verify-canonical-release-artifact.mjs": "scripts/verify-canonical-release-artifact.test.mjs",
  "scripts/verify-marketplace-publication.mjs": "scripts/verify-marketplace-publication.test.mjs",
  "scripts/verify-open-vsx-release.mjs": "scripts/verify-open-vsx-release.test.mjs",
  "scripts/verify-preview-release-artifact.mjs": "scripts/verify-registry-release-artifact.test.mjs",
  "scripts/verify-public-media-surfaces.mjs": "scripts/public-media-surfaces.test.mjs",
  "scripts/verify-registry-release-artifact.mjs": "scripts/verify-registry-release-artifact.test.mjs"
});
const RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS = Object.freeze([
  "scripts/editor-acceptance-artifact.test.mjs",
  "scripts/remote-jupyter-lock.test.mjs"
]);

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : undefined;
}

function assertStandaloneReleasedJupyterRTriples(workflow) {
  const steps = workflow?.jobs?.vscode?.steps;
  assert.ok(Array.isArray(steps), "Standalone Released-Jupyter acceptance must retain its Linux job steps.");
  const triples = [
    {
      verifier: {
        id: "canonical_r_jupyter",
        name: "Reverify the VSIX for core R operations",
        run: "npm run verify:vsix -- openwrangler.vsix"
      },
      runnerId: "packaged_editor_r",
      uploadName: "Upload packaged-editor R failure diagnostics"
    },
    {
      verifier: {
        id: "canonical_r_values",
        name: "Reverify the VSIX for value R operations",
        run: "npm run verify:vsix -- openwrangler.vsix"
      },
      runnerId: "packaged_editor_r_values",
      uploadName: "Upload value R-Jupyter failure diagnostics"
    },
    {
      verifier: {
        id: "canonical_r_categorical",
        name: "Reverify the VSIX for categorical R operations",
        run: "npm run verify:vsix -- openwrangler.vsix"
      },
      runnerId: "packaged_editor_r_categorical",
      uploadName: "Upload categorical R-Jupyter failure diagnostics"
    },
    {
      verifier: {
        id: "canonical_r_interactive",
        name: "Reverify the VSIX for the active R terminal",
        run: "npm run verify:vsix -- openwrangler.vsix"
      },
      runnerId: "packaged_editor_r_interactive",
      uploadName: "Upload active R terminal failure diagnostics"
    }
  ];

  for (const { verifier, runnerId, uploadName } of triples) {
    const verifierIndices = steps.flatMap((step, index) => (step?.id === verifier.id ? [index] : []));
    const runnerIndices = steps.flatMap((step, index) => (step?.id === runnerId ? [index] : []));
    const uploadIndices = steps.flatMap((step, index) => (step?.name === uploadName ? [index] : []));
    assert.equal(verifierIndices.length, 1, `Expected exactly one ${verifier.id} verifier.`);
    assert.equal(runnerIndices.length, 1, `Expected exactly one ${runnerId} runner.`);
    assert.equal(uploadIndices.length, 1, `Expected exactly one ${uploadName} upload.`);
    const verifierIndex = verifierIndices[0];
    const runnerIndex = runnerIndices[0];
    const uploadIndex = uploadIndices[0];
    assert.deepEqual(steps[verifierIndex], verifier, `${verifier.id} must stay an exact fresh canonical verifier.`);
    assert.equal(runnerIndex, verifierIndex + 1, `${runnerId} must immediately follow ${verifier.id}.`);
    assert.equal(uploadIndex, runnerIndex + 1, `${uploadName} must immediately follow ${runnerId}.`);
  }
}

function nodeTestFiles(command, group) {
  const segments = normalizedCommand(command)?.split(" && ") ?? [];
  const parts = segments[0]?.split(" ") ?? [];
  assert.deepEqual(
    segments.slice(1),
    group === "portable" ? ["npm run test:scripts:media"] : [],
    `${group} must not hide unrelated commands in its script contract.`
  );
  const prefix =
    group === "portable"
      ? ["node", "--test", "--test-concurrency=4"]
      : group === "release"
        ? ["node", "--test", "--test-concurrency=4"]
        : group === "media"
          ? ["node", "--max-old-space-size=1024", "--test", "--test-concurrency=1"]
          : ["node", "--test"];
  assert.deepEqual(parts.slice(0, prefix.length), prefix, `${group} must invoke Node's test runner directly.`);
  const files = parts.slice(prefix.length);
  assert.ok(files.length > 0, `${group} must own at least one script contract.`);
  for (const file of files) assert.match(file, /^scripts\/[a-z0-9.-]+\.test\.mjs$/u);
  assert.equal(new Set(files).size, files.length, `${group} must not list a script contract twice.`);
  return files;
}

function parseJavaScriptModuleSpecifiers(sourceLabel, source) {
  const sourceFile = ts.createSourceFile(sourceLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  assert.equal(sourceFile.parseDiagnostics.length, 0, `${sourceLabel} must be syntactically valid JavaScript.`);
  const specifiers = [];
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      assert.equal(
        ts.isStringLiteral(node.moduleSpecifier),
        true,
        `${sourceLabel} must use a literal static module specifier.`
      );
      specifiers.push({
        kind: ts.isImportDeclaration(node) ? "static-import" : "static-export",
        specifier: node.moduleSpecifier.text
      });
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        assert.equal(
          node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]),
          true,
          `${sourceLabel} must use one literal dynamic-import specifier.`
        );
        specifiers.push({ kind: "dynamic-import", specifier: node.arguments[0].text });
      }
      if (
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "require" || node.expression.text === "createRequire")
      ) {
        assert.fail(`${sourceLabel} must not use ${node.expression.text} as a module-loading surface.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const { specifier } of specifiers) {
    assert.equal(
      specifier === "node:module" || specifier === "module",
      false,
      `${sourceLabel} must not import a module-loader constructor.`
    );
  }
  return specifiers;
}

function parseReleaseModuleDependencies(entryPath, source) {
  const specifiers = parseJavaScriptModuleSpecifiers(entryPath, source).map((specifier) => ({
    ...specifier,
    repositoryRoot: false
  }));
  const embeddedCommandTokenCount = [...source.matchAll(/node --input-type=module -e\b/gu)].length;
  const embeddedCommands = [...source.matchAll(/node --input-type=module -e '(?<source>[^'\n]*)'/gu)];
  assert.equal(
    embeddedCommands.length,
    embeddedCommandTokenCount,
    `${entryPath} may use embedded module mode only with an exact single-quoted JavaScript snippet.`
  );
  const embeddedRootImports = embeddedCommands.map((command, index) => {
    const commandSource = command.groups?.source;
    assert.ok(commandSource, `${entryPath} embedded module command ${index + 1} must not be empty.`);
    const commandSpecifiers = parseJavaScriptModuleSpecifiers(
      `${entryPath} embedded module command ${index + 1}`,
      commandSource
    );
    assert.equal(
      commandSpecifiers.length,
      1,
      `${entryPath} embedded module command ${index + 1} must contain exactly one reviewed import.`
    );
    const [commandSpecifier] = commandSpecifiers;
    assert.equal(
      commandSpecifier.kind,
      "static-import",
      `${entryPath} embedded module command ${index + 1} must use one static import.`
    );
    assert.match(
      commandSpecifier.specifier,
      /^\.\/scripts\/[A-Za-z0-9_./-]+\.mjs$/u,
      `${entryPath} embedded module command ${index + 1} must import one literal repository-root script.`
    );
    return { ...commandSpecifier, repositoryRoot: true };
  });
  return [...specifiers, ...embeddedRootImports];
}

function localReleaseModuleDependencies(entryPath, productionPaths, visited = new Set(), sourceOverride) {
  if (visited.has(entryPath)) return new Set();
  visited.add(entryPath);
  const source = sourceOverride ?? readFileSync(new URL(`../${entryPath}`, import.meta.url), "utf8");
  const dependencies = new Set();
  for (const { repositoryRoot, specifier } of parseReleaseModuleDependencies(entryPath, source)) {
    assert.ok(specifier, `${entryPath} contains an unparseable relative import.`);
    assert.equal(
      specifier.startsWith("/") ||
        specifier.includes("\\") ||
        (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) && !specifier.startsWith("node:")),
      false,
      `${entryPath} must not load an absolute, backslash, or URL-scheme module specifier.`
    );
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
    const dependencyPath = repositoryRoot
      ? posix.normalize(specifier.slice(2))
      : posix.normalize(posix.join(posix.dirname(entryPath), specifier));
    assert.equal(
      dependencyPath.startsWith("../") || dependencyPath.startsWith("/"),
      false,
      `${entryPath} must not import outside the repository.`
    );
    dependencies.add(dependencyPath);
    if (productionPaths.has(dependencyPath) && dependencyPath.endsWith(".mjs")) {
      for (const transitivePath of localReleaseModuleDependencies(dependencyPath, productionPaths, visited)) {
        dependencies.add(transitivePath);
      }
    }
  }
  return dependencies;
}

test("product CI covers protected product branches", () => {
  const ci = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.deepEqual(ci?.on?.push?.branches, PRODUCT_PUSH_BRANCHES);
  assert.deepEqual(ci?.on?.pull_request?.types, PULL_REQUEST_ACTIVITY_TYPES);

  for (const path of ["codeql.yml", "cross-platform.yml"]) {
    const workflow = parseYaml(readFileSync(new URL(`../.github/workflows/${path}`, import.meta.url), "utf8"));
    assert.deepEqual(workflow?.on?.pull_request?.branches, PROTECTED_PULL_REQUEST_BRANCHES);
    assert.deepEqual(workflow?.on?.pull_request?.types, PULL_REQUEST_ACTIVITY_TYPES);
    assert.equal(workflow?.on?.push, undefined, `${path} must not repeat the ready-PR matrix after merge.`);
  }
});

test("script groups are pairwise-disjoint and exactly cover the filesystem inventory", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const inventory = readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => `scripts/${entry.name}`)
    .sort();
  const groups = Object.fromEntries(
    SCRIPT_TEST_GROUPS.map((group) => [
      group,
      nodeTestFiles(
        manifest?.scripts?.[`test:scripts:${group}${["portable", "media"].includes(group) ? ":run" : ""}`],
        group
      )
    ])
  );

  assert.equal(manifest?.scripts?.["test:scripts"], "npm run test:scripts:run");
  assert.equal(
    manifest?.scripts?.["test:scripts:run"],
    "npm run test:scripts:workflow && npm run test:scripts:portable && npm run test:scripts:native"
  );
  assert.equal(manifest?.scripts?.["test:scripts:portable"], "npm run test:scripts:portable:run");
  assert.equal(manifest?.scripts?.["test:scripts:media"], "npm run test:scripts:media:run");
  assert.equal(manifest?.scripts?.test, "npm run test:run");
  assert.equal(manifest?.scripts?.["test:run"], "npm run test:scripts && npm run test:ts && npm run test:python");
  assert.deepEqual(groups.workflow, ["scripts/candidate-acceptance-workflow.test.mjs", "scripts/ci-workflow.test.mjs"]);
  assert.deepEqual(groups.media, ["scripts/public-media-surfaces.test.mjs", "scripts/readme-media.test.mjs"]);
  assert.deepEqual(groups.native, ["scripts/windows-job-supervisor.native.test.mjs"]);
  assert.deepEqual(
    groups.portable,
    inventory.filter((file) =>
      SCRIPT_TEST_GROUPS.filter((group) => group !== "portable").every((group) => !groups[group].includes(file))
    )
  );

  for (let left = 0; left < SCRIPT_TEST_GROUPS.length; left += 1) {
    for (let right = left + 1; right < SCRIPT_TEST_GROUPS.length; right += 1) {
      const leftGroup = SCRIPT_TEST_GROUPS[left];
      const rightGroup = SCRIPT_TEST_GROUPS[right];
      assert.deepEqual(
        groups[leftGroup].filter((file) => groups[rightGroup].includes(file)),
        [],
        `${leftGroup} and ${rightGroup} script ownership must remain disjoint.`
      );
    }
  }
  assert.deepEqual([...new Set(SCRIPT_TEST_GROUPS.flatMap((group) => groups[group]))].sort(), inventory);
});

test("every Vitest run has an effective worker ceiling", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const config = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.config.ts", import.meta.url))
  );
  const smokeConfig = await loadConfigFromFile(
    { command: "serve", mode: "test" },
    fileURLToPath(new URL("../vite.python-environment-smoke.config.ts", import.meta.url))
  );
  const vitestScripts = Object.entries(manifest?.scripts ?? {})
    .filter(([, command]) => typeof command === "string" && command.startsWith("vitest run"))
    .sort(([left], [right]) => left.localeCompare(right));

  assert.deepEqual(vitestScripts, [
    ["test:coverage:ts", "vitest run --coverage"],
    ["test:python-environment-smoke", "vitest run --config vite.python-environment-smoke.config.ts"],
    ["test:ts", "vitest run"]
  ]);
  assert.ok(config, "The ordinary Vitest configuration must load.");
  assert.ok(smokeConfig, "The Python-environment smoke Vitest configuration must load.");
  assert.equal(config.config.test?.maxWorkers, 4);
  assert.equal(config.config.test?.coverage?.processingConcurrency, 4);
  assert.equal(smokeConfig.config.test?.maxWorkers, 1);
  assert.equal(smokeConfig.config.test?.fileParallelism, false);
});

test("PR workflows cancel only obsolete pull-request heads", () => {
  for (const [relativePath, expectedGroup] of replaceablePullRequestWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const workflow = parseYaml(source);
    assert.equal(workflow?.concurrency?.group, expectedGroup, `${relativePath} must retain its ref-scoped group.`);
    assert.equal(
      workflow?.concurrency?.["cancel-in-progress"],
      "${{ github.event_name == 'pull_request' }}",
      `${relativePath} may cancel only an obsolete pull-request run.`
    );
    assert.ok(workflow?.on?.pull_request !== undefined, `${relativePath} must still run for pull requests.`);
    assert.ok(
      Object.keys(workflow?.on ?? {}).some((eventName) => eventName !== "pull_request"),
      `${relativePath} must retain non-PR evidence that the cancellation expression leaves uninterrupted.`
    );
    for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
      assert.equal(
        String(job?.if ?? "").includes("always()"),
        false,
        `${relativePath}:${jobId} must not resist cancellation with always().`
      );
      for (const [stepIndex, step] of (job?.steps ?? []).entries()) {
        assert.equal(
          String(step?.if ?? "").includes("always()"),
          false,
          `${relativePath}:${jobId}:step-${stepIndex + 1} must not resist cancellation with always().`
        );
      }
    }
  }
});

test("NUL-safe path classification fast-paths only explicit non-packaged documentation", () => {
  assert.deepEqual(
    parseChangedPathBuffer(Buffer.from("docs/testing.md\0AGENTS.md\0docs/images/über.png\0docs/a\nfile.md\0", "utf8")),
    ["docs/testing.md", "AGENTS.md", "docs/images/über.png", "docs/a\nfile.md"]
  );
  assert.throws(() => parseChangedPathBuffer(Buffer.from("src/extension/activate.ts", "utf8")), /NUL terminated/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from("README.md\0\0", "utf8")), /empty path/u);
  assert.throws(() => parseChangedPathBuffer(Buffer.from([0xff, 0])), /encoded data/u);
  assert.throws(() => parseChangedPathBuffer("AGENTS.md\0"), /provided as a Buffer/u);

  const documentationOnly = (eventName, changedPaths) => isDocumentationOnlyChangeSet({ eventName, changedPaths });
  const benchmarkHarnessOnly = (eventName, changedPaths) =>
    isBenchmarkHarnessOnlyChangeSet({ eventName, changedPaths });
  const packageOnly = (eventName, changedPaths) => isPackageOnlyChangeSet({ eventName, changedPaths });
  const dependencyLockOnly = (eventName, changedPaths) => isDependencyLockOnlyChangeSet({ eventName, changedPaths });
  const allowed = [
    "AGENTS.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "SUPPORT.md",
    "docs/testing.md",
    "docs/a\nfile.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/PULL_REQUEST_TEMPLATE/docs.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    ".github/pull_request_template.md"
  ];
  assert.equal(documentationOnly("pull_request", allowed), true);
  assert.deepEqual(classifyCiChange({ eventName: "pull_request", changedPaths: allowed, pullRequestDraft: "false" }), {
    benchmarkHarnessOnly: false,
    dependencyLockOnly: false,
    documentationOnly: true,
    draftPullRequest: false,
    lightweightOnly: true,
    packageOnly: false,
    releaseInfrastructureOnly: false,
    fullMatrixRequired: false
  });
  const packagedDocuments = ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"];
  assert.equal(packageOnly("pull_request", packagedDocuments), true);
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: packagedDocuments, pullRequestDraft: "false" }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: false,
      lightweightOnly: false,
      packageOnly: true,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: packagedDocuments, pullRequestDraft: "true" }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: true,
      lightweightOnly: true,
      packageOnly: true,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  assert.equal(dependencyLockOnly("pull_request", ["package-lock.json"]), true);
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["package-lock.json"], pullRequestDraft: "false" }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: true,
      documentationOnly: false,
      draftPullRequest: false,
      lightweightOnly: false,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  assert.deepEqual(
    classifyCiChange({ eventName: "pull_request", changedPaths: ["package-lock.json"], pullRequestDraft: "true" }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: true,
      documentationOnly: false,
      draftPullRequest: true,
      lightweightOnly: true,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  const benchmarkHarnessPaths = [
    "docs/performance-comparison.md",
    "docs/testing.md",
    "python/benchmarks/local_mixed_parquet.py",
    "python/tests/test_installed_editor_fixtures.py",
    "scripts/data-wrangler-comparison-neutral-driver.mjs",
    "scripts/data-wrangler-comparison-neutral-driver.test.mjs",
    "scripts/data-wrangler-comparison-study.mjs",
    "scripts/data-wrangler-comparison-study.test.mjs",
    "scripts/linux-pss-sampler.mjs",
    "scripts/linux-pss-sampler.test.mjs",
    "src/test/dataWranglerComparisonNotebookTrial.unit.test.ts",
    "src/test/extensionHost/dataWranglerComparisonNotebookTrial.ts"
  ];
  assert.deepEqual(BENCHMARK_HARNESS_PATHS, benchmarkHarnessPaths);
  assert.equal(Object.isFrozen(BENCHMARK_HARNESS_PATHS), true);
  assert.equal(benchmarkHarnessOnly("pull_request", benchmarkHarnessPaths), true);
  assert.deepEqual(
    classifyCiChange({
      eventName: "pull_request",
      changedPaths: benchmarkHarnessPaths,
      pullRequestDraft: "false"
    }),
    {
      benchmarkHarnessOnly: true,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: false,
      lightweightOnly: false,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  assert.deepEqual(
    classifyCiChange({
      eventName: "pull_request",
      changedPaths: benchmarkHarnessPaths,
      pullRequestDraft: "true"
    }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: true,
      lightweightOnly: true,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  for (const unexpectedPath of [
    ".github/workflows/ci.yml",
    "package.json",
    "python/benchmarks/runtime_performance.py",
    "python/openwrangler_runtime/session.py",
    "src/extension/sessionCoordinator.ts",
    "src/test/unrelated.unit.test.ts"
  ]) {
    const changedPaths = ["scripts/data-wrangler-comparison-study.mjs", unexpectedPath];
    assert.equal(
      benchmarkHarnessOnly("pull_request", changedPaths),
      false,
      `${unexpectedPath} must fall back to the full matrix.`
    );
    assert.equal(
      classifyCiChange({ eventName: "pull_request", changedPaths, pullRequestDraft: "false" }).fullMatrixRequired,
      true,
      `${unexpectedPath} must require the full matrix.`
    );
  }
  for (const changedPaths of [
    [],
    ["package.json"],
    ["package-lock.json", "package.json"],
    ["package-lock.json", "README.md"],
    ["./package-lock.json"],
    ["Package-lock.json"]
  ]) {
    assert.equal(
      dependencyLockOnly("pull_request", changedPaths),
      false,
      JSON.stringify(changedPaths) + " must not select dependency-lock-only CI."
    );
  }
  for (const path of [
    ".github/workflows/ci.yml",
    ".vscodeignore",
    "assets/openwrangler.png",
    "package.json",
    "protocol/openwrangler.v2.schema.json",
    "python/openwrangler_runtime/notebook.py",
    "scripts/build-webviews.mjs",
    "src/extension/notebooks/jupyterBridge.ts",
    "src/webviews/notebookRenderer.ts",
    "docs/images/acceptance/grid-dark-1920.png",
    "docs/images/editor-acceptance/vscode-hero-dark.png",
    "docs/images/readme/v1.2/explore.png",
    "docs/images/legacy.png",
    "docs/media-gallery.md",
    "docs/media-spec-v1.2.md",
    "docs/../src/extension/activate.ts",
    "/docs/testing.md",
    "docs//testing.md",
    "docs\\testing.md",
    "Docs/testing.md",
    ".github/ISSUE_TEMPLATE",
    ".github/PULL_REQUEST_TEMPLATE",
    "unknown/future-package-surface"
  ]) {
    assert.equal(documentationOnly("pull_request", [path]), false, `${path} must require the complete PR matrix.`);
    assert.equal(packageOnly("pull_request", [path]), false, `${path} must not select package-only CI.`);
  }
  for (const path of packagedDocuments) {
    assert.equal(documentationOnly("pull_request", [path]), false, `${path} is shipped, not documentation-only.`);
    assert.equal(packageOnly("pull_request", [path]), true, `${path} must select package-only CI.`);
  }
  assert.equal(packageOnly("pull_request", ["README.md", "docs/testing.md"]), false);
  assert.equal(packageOnly("pull_request", ["README.md", "src/shared/notebookOutput.ts"]), false);
  assert.equal(documentationOnly("pull_request", ["docs/testing.md", "src/shared/notebookOutput.ts"]), false);
  assert.deepEqual(
    classifyCiChange({
      eventName: "pull_request",
      changedPaths: ["src/shared/notebookOutput.ts"],
      pullRequestDraft: "true"
    }),
    {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: true,
      lightweightOnly: true,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: false
    }
  );
  assert.equal(documentationOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(packageOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(dependencyLockOnly("pull_request", []), false, "an empty PR diff must fail closed");
  assert.equal(benchmarkHarnessOnly("pull_request", []), false, "an empty PR diff must fail closed");
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    assert.equal(documentationOnly(eventName, allowed), false, `${eventName} must always use the complete workflow.`);
    assert.equal(
      packageOnly(eventName, packagedDocuments),
      false,
      `${eventName} must always use the complete workflow.`
    );
    assert.equal(dependencyLockOnly(eventName, ["package-lock.json"]), false, `${eventName} must use full CI.`);
    assert.equal(benchmarkHarnessOnly(eventName, benchmarkHarnessPaths), false, `${eventName} must use full CI.`);
    assert.deepEqual(classifyCiChange({ eventName, changedPaths: [], pullRequestDraft: "" }), {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      documentationOnly: false,
      draftPullRequest: false,
      lightweightOnly: false,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      fullMatrixRequired: true
    });
  }
  assert.equal(documentationOnly("pull_request", [undefined]), false);
  assert.equal(documentationOnly("pull_request", ["docs/testing.md", 42]), false);
  assert.throws(() => documentationOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.throws(() => benchmarkHarnessOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.throws(() => packageOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.throws(() => dependencyLockOnly("pull_request", undefined), /changedPaths must be an array/u);
  assert.equal(parsePullRequestDraft({ eventName: "pull_request", value: "true" }), true);
  assert.equal(parsePullRequestDraft({ eventName: "pull_request", value: "false" }), false);
  for (const value of [undefined, "", "TRUE", "0", true, false]) {
    assert.throws(
      () => parsePullRequestDraft({ eventName: "pull_request", value }),
      /draft state must be exactly true or false/u
    );
  }
  assert.equal(parsePullRequestDraft({ eventName: "push", value: "" }), false);
  assert.equal(parsePullRequestDraft({ eventName: "schedule", value: undefined }), false);
  assert.throws(
    () => parsePullRequestDraft({ eventName: "push", value: "false" }),
    /must not carry pull-request draft state/u
  );
});

test("release-infrastructure classification is an exact fail-closed allowlist with closed dependencies", () => {
  const primaryPaths = [...RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS, ...RELEASE_INFRASTRUCTURE_TEST_PATHS];
  const productionPaths = new Set(RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS);
  const baselinePath = "scripts/download-canonical-github-release.mjs";
  const releaseRegistries = {
    adjunct: RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS,
    "classification-test": RELEASE_INFRASTRUCTURE_TEST_PATHS,
    "extra-focused-test": RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS,
    production: RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS,
    "shared-dependency": RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS
  };

  for (const paths of [
    RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS,
    RELEASE_INFRASTRUCTURE_TEST_PATHS,
    RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS,
    RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS,
    RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS
  ]) {
    assert.equal(Object.isFrozen(paths), true);
    assert.deepEqual(paths, [...paths].sort(), "Release-infrastructure registries must stay canonical and sorted.");
    assert.equal(new Set(paths).size, paths.length, "Release-infrastructure registries must not contain duplicates.");
    for (const path of paths) {
      assert.doesNotThrow(() => readFileSync(new URL(`../${path}`, import.meta.url)));
    }
  }
  const registryEntries = Object.entries(releaseRegistries);
  for (let left = 0; left < registryEntries.length; left += 1) {
    for (let right = left + 1; right < registryEntries.length; right += 1) {
      const [leftName, leftPaths] = registryEntries[left];
      const [rightName, rightPaths] = registryEntries[right];
      assert.deepEqual(
        leftPaths.filter((path) => rightPaths.includes(path)),
        [],
        `${leftName} and ${rightName} release registries must remain disjoint.`
      );
    }
  }
  assert.deepEqual(
    RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS,
    [
      "CHANGELOG.md",
      "README.md",
      "docs/ci.md",
      "docs/media-gallery.md",
      "docs/media-spec-v1.2.md",
      "docs/releasing.md",
      "docs/testing.md"
    ],
    "Only exact release-adjacent documents may accompany a primary release-infrastructure change."
  );
  assert.deepEqual(RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS, [
    "scripts/data-wrangler-comparison-report.mjs",
    "scripts/run-installed-performance.mjs",
    "scripts/strict-json.mjs",
    "scripts/vsix-archive.mjs",
    "scripts/vsix-contents.mjs"
  ]);
  assert.deepEqual(
    Object.keys(RELEASE_INFRASTRUCTURE_TEST_OWNER),
    RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS,
    "Every production allowlist entry needs an explicitly reviewed focused-test owner."
  );

  const ci = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const releaseJob = ci?.jobs?.[RELEASE_INFRASTRUCTURE_CI_JOBS[0]];
  const transactionFiles = nodeTestFiles(
    releaseJob?.steps?.find((step) => step?.name === "Release transaction contracts")?.run,
    "release"
  );
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const mediaFiles = nodeTestFiles(manifest?.scripts?.["test:scripts:media:run"], "media");
  const focusedTestFiles = [...transactionFiles, ...mediaFiles].sort();
  assert.deepEqual(
    focusedTestFiles.filter((path) => !RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS.includes(path)),
    RELEASE_INFRASTRUCTURE_TEST_PATHS,
    "The executable release job and media command must exactly own every classification-allowed test."
  );
  assert.deepEqual(
    focusedTestFiles.filter((path) => !RELEASE_INFRASTRUCTURE_TEST_PATHS.includes(path)),
    RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS,
    "Candidate-boundary tests run in the focused job but must remain outside the path-classification allowlist."
  );
  for (const [productionPath, ownerPath] of Object.entries(RELEASE_INFRASTRUCTURE_TEST_OWNER)) {
    assert.equal(
      focusedTestFiles.includes(ownerPath),
      true,
      `${productionPath} must retain executable evidence from ${ownerPath}.`
    );
    if (productionPath.endsWith(".mjs")) {
      assert.equal(
        localReleaseModuleDependencies(ownerPath, productionPaths).has(productionPath),
        true,
        `${ownerPath} must import ${productionPath} through the reviewed release module graph.`
      );
    } else {
      assert.equal(
        readFileSync(new URL(`../${ownerPath}`, import.meta.url), "utf8").includes(productionPath),
        true,
        `${ownerPath} must inspect ${productionPath} explicitly.`
      );
    }
  }

  const dependencies = new Set();
  for (const productionPath of RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS.filter((path) => path.endsWith(".mjs"))) {
    for (const dependencyPath of localReleaseModuleDependencies(productionPath, productionPaths)) {
      dependencies.add(dependencyPath);
    }
  }
  const outOfTierDependencies = [...dependencies].filter((path) => !productionPaths.has(path)).sort();
  assert.deepEqual(
    outOfTierDependencies,
    RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS,
    "Every transitive local module dependency outside the tier must be explicitly registered to force full CI."
  );
  assert.deepEqual(
    primaryPaths.filter((path) => RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS.includes(path)),
    [],
    "Shared release dependencies must never enter the narrow primary allowlist."
  );
  assert.deepEqual(
    [
      ...localReleaseModuleDependencies(
        "scripts/synthetic-release.mjs",
        productionPaths,
        new Set(),
        'import("./strict-json.mjs");'
      )
    ],
    ["scripts/strict-json.mjs"],
    "Literal dynamic imports must enter the dependency closure."
  );
  assert.deepEqual(
    [
      ...localReleaseModuleDependencies(
        "scripts/synthetic-release.mjs",
        productionPaths,
        new Set(),
        "const command = `node --input-type=module -e 'import { x } from \"./scripts/strict-json.mjs\"; x();'`;"
      )
    ],
    ["scripts/strict-json.mjs"],
    "Only the reviewed embedded node-module command form may resolve from the repository root."
  );
  for (const [label, source, message] of [
    ["computed dynamic import", "import(modulePath);", /literal dynamic-import/u],
    [
      "computed embedded import",
      "const command = `node --input-type=module -e 'import(modulePath);'`;",
      /literal dynamic-import/u
    ],
    [
      "second embedded import",
      'const command = `node --input-type=module -e \'import "./scripts/strict-json.mjs"; import { x } from "./scripts/release-metadata.mjs"; x();\'`;',
      /exactly one reviewed import/u
    ],
    ["require", 'require("./strict-json.mjs");', /must not use require/u],
    ["createRequire", "createRequire(import.meta.url);", /must not use createRequire/u],
    ["POSIX absolute import", 'import("/tmp/local.mjs");', /absolute, backslash, or URL-scheme/u],
    ["file URL import", 'import("file:///tmp/local.mjs");', /absolute, backslash, or URL-scheme/u],
    ["data URL import", 'import("data:text/javascript,export default 1");', /URL-scheme/u],
    ["HTTP URL import", 'import("https://example.com/local.mjs");', /URL-scheme/u],
    ["Windows drive import", 'import("C:\\\\temp\\\\local.mjs");', /absolute, backslash, or URL-scheme/u],
    ["Windows UNC import", 'import("\\\\\\\\server\\\\share\\\\local.mjs");', /backslash/u],
    [
      "aliased createRequire",
      'import { createRequire as loader } from "node:module"; loader(import.meta.url);',
      /module-loader constructor/u
    ],
    [
      "namespace createRequire",
      'import * as moduleApi from "module"; moduleApi.createRequire(import.meta.url);',
      /module-loader constructor/u
    ]
  ]) {
    assert.throws(
      () => localReleaseModuleDependencies("scripts/synthetic-release.mjs", productionPaths, new Set(), source),
      message,
      `${label} must fail the release dependency inspector closed.`
    );
  }

  for (const primaryPath of primaryPaths) {
    assert.equal(
      isReleaseInfrastructureOnlyChangeSet({ eventName: "pull_request", changedPaths: [primaryPath] }),
      true,
      `${primaryPath} must select the focused release-infrastructure tier.`
    );
    assert.deepEqual(
      classifyCiChange({ eventName: "pull_request", changedPaths: [primaryPath], pullRequestDraft: "false" }),
      {
        benchmarkHarnessOnly: false,
        dependencyLockOnly: false,
        documentationOnly: false,
        draftPullRequest: false,
        lightweightOnly: false,
        packageOnly: false,
        releaseInfrastructureOnly: true,
        fullMatrixRequired: false
      }
    );
  }
  assert.equal(
    isReleaseInfrastructureOnlyChangeSet({
      eventName: "pull_request",
      changedPaths: [...primaryPaths, ...RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS]
    }),
    true
  );
  assert.equal(
    isReleaseInfrastructureOnlyChangeSet({
      eventName: "pull_request",
      changedPaths: RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS
    }),
    false,
    "Adjunct documents cannot select this tier without primary code or a focused test."
  );

  for (const unexpectedPath of [
    ...RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS,
    ...RELEASE_INFRASTRUCTURE_EXTRA_FOCUSED_TEST_PATHS,
    ".github/workflows/candidate-acceptance.yml",
    ".github/workflows/open-vsx-promotion.yml",
    ".github/workflows/release.yml",
    ".github/workflows/stable-release.yml",
    "azure-pipelines-marketplace.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/cross-platform.yml",
    "package.json",
    "scripts/ci-path-classification.mjs",
    "scripts/ci-workflow.test.mjs",
    "scripts/push-release-tag.mjs",
    "scripts/require-ci-results.mjs",
    "scripts/verify-open-vsx-github-release.mjs",
    "src/extension/activate.ts",
    "python/openwrangler_runtime/session.py"
  ]) {
    const changedPaths = [baselinePath, unexpectedPath];
    assert.equal(
      isReleaseInfrastructureOnlyChangeSet({ eventName: "pull_request", changedPaths }),
      false,
      `${unexpectedPath} must force full CI when mixed with release infrastructure.`
    );
    assert.equal(
      classifyCiChange({ eventName: "pull_request", changedPaths, pullRequestDraft: "false" }).fullMatrixRequired,
      true,
      `${unexpectedPath} must fail closed to full CI.`
    );
  }
  for (const changedPaths of [
    ["azure-pipelines-marketplace.yml"],
    ["azure-pipelines-marketplace.yml", "scripts/marketplace-promotion-workflow.mjs"]
  ]) {
    assert.equal(
      isReleaseInfrastructureOnlyChangeSet({ eventName: "pull_request", changedPaths }),
      false,
      "The Azure pipeline must force full CI alone and with its allowlisted hash-owning inspector."
    );
    assert.equal(
      classifyCiChange({ eventName: "pull_request", changedPaths, pullRequestDraft: "false" }).fullMatrixRequired,
      true
    );
  }
  for (const malformedPath of ["./scripts/download-canonical-github-release.mjs", "scripts//x.mjs", "../x.mjs", 42]) {
    const changedPaths = [baselinePath, malformedPath];
    assert.equal(isReleaseInfrastructureOnlyChangeSet({ eventName: "pull_request", changedPaths }), false);
    assert.equal(
      classifyCiChange({ eventName: "pull_request", changedPaths, pullRequestDraft: "false" }).fullMatrixRequired,
      true
    );
  }
  assert.equal(
    classifyCiChange({ eventName: "pull_request", changedPaths: [baselinePath], pullRequestDraft: "true" })
      .releaseInfrastructureOnly,
    false,
    "Draft PRs retain lightweight feedback until they become ready."
  );
  for (const eventName of ["push", "schedule", "workflow_dispatch"]) {
    const classification = classifyCiChange({ eventName, changedPaths: [baselinePath], pullRequestDraft: "" });
    assert.equal(classification.releaseInfrastructureOnly, false);
    assert.equal(classification.fullMatrixRequired, true);
  }
  assert.throws(
    () => isReleaseInfrastructureOnlyChangeSet({ eventName: "pull_request", changedPaths: undefined }),
    /changedPaths must be an array/u
  );
});

test("documentation fast-path roots remain excluded from the VSIX inventory", () => {
  const ignored = new Set(
    readFileSync(new URL("../.vscodeignore", import.meta.url), "utf8")
      .split(/\r?\n/gu)
      .filter(Boolean)
  );
  for (const path of ["docs/**", "AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]) {
    assert.equal(ignored.has(path), true, `${path} must remain outside the packaged extension.`);
  }
  for (const path of ["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert.equal(ignored.has(path), false, `${path} changes shipped extension bytes and must keep packaging CI.`);
  }
});

test("native packaged-editor and released-Jupyter journeys stay at the release boundary", () => {
  const ci = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  for (const jobId of [
    "released-jupyter",
    "native-script-portability",
    "native-extension-host",
    "native-editor-matrix",
    "native-cursor-smoke"
  ]) {
    assert.equal(ci?.jobs?.[jobId], undefined, `${jobId} must not run on every pull request.`);
  }

  for (const relativePath of [".github/workflows/release.yml", ".github/workflows/stable-release.yml"]) {
    const workflow = parseYaml(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
    const candidate = workflow?.jobs?.["candidate-acceptance"];
    assert.deepEqual(candidate, {
      name: "Candidate acceptance",
      needs: "package",
      uses: "./.github/workflows/candidate-acceptance.yml",
      permissions: { contents: "read" },
      with: {
        artifact_id: "${{ needs.package.outputs.artifact-id }}",
        channel: relativePath.endsWith("/release.yml") ? "preview" : "stable",
        expected_sha: "${{ github.sha }}",
        release_tag: "${{ inputs.release_tag }}"
      }
    });
  }

  const acceptance = parseYaml(
    readFileSync(new URL("../.github/workflows/candidate-acceptance.yml", import.meta.url), "utf8")
  );
  assert.deepEqual(Object.keys(acceptance.on.workflow_call.inputs), [
    "artifact_id",
    "channel",
    "expected_sha",
    "release_tag"
  ]);
  assert.equal(acceptance.on.workflow_call.outputs, undefined);
  assert.deepEqual(Object.keys(acceptance.jobs), [
    "contract",
    "platform",
    "linux",
    "performance",
    "jupyter",
    "r_contract",
    "r_local",
    "acceptance"
  ]);

  const platform = acceptance.jobs.platform;
  assert.deepEqual(platform.strategy, {
    "fail-fast": false,
    "max-parallel": 2,
    matrix: {
      include: [
        { os: "macos-latest", python: "3.12" },
        { os: "windows-latest", python: "3.14" }
      ]
    }
  });
  assert.equal(platform["runs-on"], "${{ matrix.os }}");

  const releasedJupyter = acceptance.jobs.jupyter;
  assert.deepEqual(releasedJupyter.strategy, {
    "fail-fast": false,
    "max-parallel": 2,
    matrix: { phase: ["python", "r-remote"] }
  });
  assert.equal(
    releasedJupyter.steps.some((step) => step.run === "npm run test:r-contract"),
    false
  );
  assert.equal(
    releasedJupyter.steps.find((step) => step.id === "packaged_editor_r_remote")?.env?.OPEN_WRANGLER_PACKAGED_R_JOURNEY,
    "remote-r-jupyter"
  );

  const rContract = acceptance.jobs.r_contract;
  const rLocal = acceptance.jobs.r_local;
  assert.equal(rContract.needs, "contract");
  assert.equal(rLocal.needs, "contract");
  assert.equal(
    rContract.steps.some((step) => step.run === "npm run test:r-contract"),
    true
  );
  assert.deepEqual(rLocal.strategy, {
    "fail-fast": false,
    "max-parallel": 2,
    matrix: { shard: ["lifecycle", "editing"] }
  });
  assert.deepEqual(
    rLocal.steps
      .filter((step) => step.id?.startsWith("packaged_editor_r_"))
      .map((step) => [step.id, step.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY]),
    [
      ["packaged_editor_r_core", "core-operations"],
      ["packaged_editor_r_interactive", "interactive-terminal"],
      ["packaged_editor_r_literate", "literate-documents"],
      ["packaged_editor_r_values", "value-operations"],
      ["packaged_editor_r_categorical", "categorical-operations"]
    ]
  );
  for (const runner of rLocal.steps.filter((step) => step.id?.startsWith("packaged_editor_r_"))) {
    assert.equal(runner["continue-on-error"], true);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode,cursor");
    const index = rLocal.steps.indexOf(runner);
    assert.match(rLocal.steps[index - 1].id, /^canonical_r_/u);
    assert.equal(rLocal.steps[index + 1].uses, "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
  }
  assert.equal(rLocal.steps.at(-1).name, "Require successful local R shard outcomes");
  assert.equal(rLocal.steps.at(-1).if, "${{ always() }}");

  assert.deepEqual(acceptance.jobs.acceptance.needs, [
    "contract",
    "platform",
    "linux",
    "performance",
    "jupyter",
    "r_contract",
    "r_local"
  ]);
  assert.equal(acceptance.jobs.acceptance.if, "${{ always() }}");
});

test("PR CI gates expensive work behind bounded preflight lanes without removing checks", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const fastFeedback = workflow?.jobs?.["fast-feedback"];
  assert.equal(fastFeedback?.name, "Fast feedback");
  assert.equal(fastFeedback?.["runs-on"], "ubuntu-latest");
  assert.equal(fastFeedback?.["timeout-minutes"], 15);
  assert.equal(fastFeedback?.needs, undefined, "Fast feedback must not wait for the canonical VSIX.");
  assert.equal(fastFeedback?.if, undefined, "Fast feedback must run on every CI event.");

  assert.deepEqual(
    fastFeedback?.steps,
    [
      { uses: "actions/checkout@v6" },
      {
        uses: "actions/setup-node@v6",
        with: { "node-version": 22, cache: "npm" }
      },
      { run: "npm ci" },
      { name: "Formatting", run: "npm run format:check" },
      { name: "ESLint", run: "npm run lint" },
      { name: "Strict TypeScript", run: "npm run typecheck" },
      { name: "Protocol freshness", run: "npm run protocol:check" },
      { name: "Reference freshness", run: "npm run reference:check" },
      { name: "Documentation freshness", run: "npm run docs:check" },
      { name: "Production license inventory", run: "npm run license:check" },
      { name: "Workflow contracts", run: "npm run test:scripts:workflow" }
    ],
    "The early lane must remain source-only, named, and independently attributable."
  );

  const contractSteps = workflow?.jobs?.["contract-tests"]?.steps;
  assert.ok(Array.isArray(contractSteps));
  for (const command of [
    "npm run lint:python",
    "npm run brand:check",
    "npm run check:remote-jupyter-lock",
    "npm run lock:remote-jupyter:check",
    "npm run test:scripts:portable"
  ]) {
    assert.equal(
      contractSteps.some((step) => step?.run === command),
      true,
      `${command} must remain an authoritative contract gate.`
    );
  }
  for (const duplicate of ["npm run test:ts", "npm run test:python"]) {
    assert.equal(
      contractSteps.some((step) => step?.run === duplicate),
      false,
      `${duplicate} belongs to the stronger coverage lane and must not be repeated by contract-tests.`
    );
  }
  assert.deepEqual(workflow?.jobs?.["canonical-vsix"]?.needs, ["classify", "fast-feedback"]);
  assert.deepEqual(workflow?.jobs?.["contract-tests"]?.needs, ["classify", "fast-feedback"]);
  assert.equal(workflow?.jobs?.["contract-tests"]?.if, CONTRACT_CI_IF);
});

test("benchmark-only PRs run one focused harness lane without launching the benchmark", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.[BENCHMARK_HARNESS_CI_JOBS[0]];

  assert.equal(job?.name, "Benchmark harness");
  assert.deepEqual(job?.needs, ["classify", "fast-feedback"]);
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.equal(job?.["timeout-minutes"], 15);
  assert.equal(
    normalizedCommand(job?.if),
    "${{ !cancelled() && github.event_name == 'pull_request' && needs.classify.result == 'success' && needs.fast-feedback.result == 'success' && needs.classify.outputs.benchmark_harness_only == 'true' && needs.classify.outputs.draft_pull_request == 'false' }}"
  );

  const commands = (job?.steps ?? [])
    .filter((step) => typeof step?.run === "string")
    .map((step) => normalizedCommand(step.run));
  assert.deepEqual(commands, [
    "npm ci",
    "python -m pip install --upgrade pip",
    'python -m pip install -e "python[dev]"',
    "node --test scripts/data-wrangler-comparison-study.test.mjs scripts/data-wrangler-comparison-neutral-driver.test.mjs scripts/linux-pss-sampler.test.mjs",
    "npx vitest run src/test/dataWranglerComparisonNotebookTrial.unit.test.ts",
    "python -m pytest python/tests/test_installed_editor_fixtures.py -q",
    "npm run build:test-extension"
  ]);
  assert.equal(
    commands.some((command) => command?.includes("data-wrangler-comparison-study.mjs --")),
    false,
    "CI validates the harness without running the proprietary comparison."
  );
  for (const omitted of [
    "npm run build",
    "npm run package",
    "npm run test:webview-acceptance",
    "npm run test:coverage",
    "npm run test:extension-host",
    "npm run test:python",
    "npm run test:r-contract"
  ]) {
    assert.equal(commands.includes(omitted), false, `${omitted} must stay out.`);
  }
});

test("release-infrastructure PRs run only the fixed executable release contracts and canonical package", () => {
  const workflow = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  const job = workflow?.jobs?.[RELEASE_INFRASTRUCTURE_CI_JOBS[0]];
  const transactionFiles = [
    "scripts/candidate-acceptance-workflow.test.mjs",
    "scripts/create-canonical-release-artifact.test.mjs",
    "scripts/download-canonical-github-release.test.mjs",
    "scripts/editor-acceptance-artifact.test.mjs",
    "scripts/marketplace-identity-profile.test.mjs",
    "scripts/marketplace-promotion-workflow.test.mjs",
    "scripts/marketplace-release-intake.test.mjs",
    "scripts/open-vsx-promotion-workflow.test.mjs",
    "scripts/package-current-channel.test.mjs",
    "scripts/prepare-stable-candidate-tag.test.mjs",
    "scripts/public-repository-metadata.test.mjs",
    "scripts/publish-github-stable-release.test.mjs",
    "scripts/push-stable-release-tag.test.mjs",
    "scripts/registry-release-source.test.mjs",
    "scripts/release-readiness.test.mjs",
    "scripts/remote-jupyter-lock.test.mjs",
    "scripts/stable-release-workflow.test.mjs",
    "scripts/verify-canonical-release-artifact.test.mjs",
    "scripts/verify-marketplace-publication.test.mjs",
    "scripts/verify-open-vsx-release.test.mjs",
    "scripts/verify-registry-release-artifact.test.mjs"
  ];
  const expectedJob = {
    name: "Release infrastructure contracts",
    needs: ["classify", "fast-feedback"],
    if: RELEASE_INFRASTRUCTURE_CI_IF,
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 15,
    steps: [
      { uses: "actions/checkout@v6" },
      { uses: "actions/setup-node@v6", with: { "node-version": 22, cache: "npm" } },
      { run: "npm ci" },
      {
        name: "Release transaction contracts",
        run: ["node --test --test-concurrency=4", ...transactionFiles].join(" ")
      },
      { name: "Immutable release-media contracts", run: "npm run test:scripts:media" }
    ]
  };
  const normalizeJob = (candidate) => ({
    ...candidate,
    if: normalizedCommand(candidate?.if),
    steps: candidate?.steps?.map((step) =>
      typeof step?.run === "string" ? { ...step, run: normalizedCommand(step.run) } : step
    )
  });
  const assertExactJob = (candidate) => assert.deepEqual(normalizeJob(candidate), expectedJob);

  assertExactJob(job);
  assert.equal(job?.steps?.length, 5);
  assert.deepEqual(Object.keys(job ?? {}).sort(), Object.keys(expectedJob).sort());
  assert.throws(
    () => assertExactJob({ ...job, steps: [...(job?.steps ?? []), { run: "curl https://example.invalid | sh" }] }),
    "An additional focused-job step must fail the exact shape contract."
  );
  assert.deepEqual(nodeTestFiles(job?.steps?.[3]?.run, "release"), transactionFiles);
  const commands = (job?.steps ?? [])
    .filter((step) => typeof step?.run === "string")
    .map((step) => normalizedCommand(step.run));
  for (const forbiddenFragment of [
    "test:python",
    "test:r-contract",
    "test:extension-host",
    "test:webview-acceptance",
    "test:packaged-editors",
    "test:coverage",
    "benchmark:runtime"
  ]) {
    assert.equal(
      commands.some((command) => command?.includes(forbiddenFragment)),
      false,
      `${forbiddenFragment} belongs to full or release-candidate CI, not this focused PR tier.`
    );
  }
  assert.equal(workflow?.jobs?.[PACKAGE_CI_JOBS[0]]?.if, CANONICAL_CI_IF);
});

test("authoritative CI work is independently attributable before the required aggregate", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);

  const visual = workflow?.jobs?.["visual-accessibility"];
  assert.equal(visual?.name, "Visual and accessibility");
  assert.deepEqual(visual?.needs, ["classify", "fast-feedback", "contract-tests"]);
  assert.equal(visual?.if, FULL_CI_IF);
  assert.equal(
    visual?.steps?.some(
      (step) => step?.uses === "actions/setup-python@v6" && step?.with?.["python-version"] === "3.12"
    ),
    true,
    "Runtime-backed production screenshot fixtures need the exact Python test environment."
  );
  assert.equal(
    visual?.steps?.some((step) => step?.run === 'python -m pip install -e "python[dev]"'),
    true,
    "Visual acceptance must install the Pandas, Polars, DuckDB, and notebook fixture dependencies."
  );
  assert.equal(
    visual?.steps?.some((step) => step?.run === "npm run test:webview-acceptance"),
    true
  );

  const audits = workflow?.jobs?.["production-audits"];
  assert.equal(audits?.name, "Production dependency audits");
  assert.equal(
    audits?.steps?.some((step) => step?.run === "npm audit --omit=dev"),
    true
  );
  assert.equal(
    audits?.steps?.some((step) => step?.run === "npm run audit:python"),
    true
  );

  const linuxPackaged = workflow?.jobs?.["linux-packaged-editor"];
  assert.deepEqual(linuxPackaged?.needs, ["classify", "fast-feedback", "contract-tests", "canonical-vsix"]);
  assert.equal(linuxPackaged?.if, FULL_CI_IF);
  assert.match(
    linuxPackaged?.steps?.find((step) => step?.name === "Require the canonical PR artifact")?.if ?? "",
    /needs\.canonical-vsix\.result != 'success'/u
  );
  assert.equal(
    linuxPackaged?.steps?.some((step) => step?.id === "packaged_editor"),
    true
  );

  const ownersByCommand = new Map();
  for (const [jobId, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of job?.steps ?? []) {
      if (step?.run === "npm run test:scripts:workflow" || step?.run === "npm run test:scripts:portable") {
        const owners = ownersByCommand.get(step.run) ?? [];
        owners.push(jobId);
        ownersByCommand.set(step.run, owners);
      }
    }
  }
  assert.deepEqual(ownersByCommand.get("npm run test:scripts:workflow"), ["fast-feedback"]);
  assert.deepEqual(ownersByCommand.get("npm run test:scripts:portable"), ["contract-tests"]);
});

test("ready substantive PRs run full while protected pushes keep only fast feedback", () => {
  const classifierEnvironment = {
    CI_EVENT_NAME: "${{ github.event_name }}",
    CI_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
    CI_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    CI_PR_DRAFT: "${{ github.event.pull_request.draft }}"
  };
  const loadWorkflow = (relativePath) =>
    parseYaml(readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"));
  const assertClassifier = (workflow, name) => {
    const job = workflow?.jobs?.classify;
    assert.equal(job?.name, name);
    assert.equal(job?.["runs-on"], "ubuntu-latest");
    assert.equal(job?.["timeout-minutes"], 5);
    assert.equal(job?.outputs?.benchmark_harness_only, "${{ steps.classify.outputs.benchmark_harness_only }}");
    assert.equal(job?.outputs?.dependency_lock_only, "${{ steps.classify.outputs.dependency_lock_only }}");
    assert.equal(job?.outputs?.documentation_only, "${{ steps.classify.outputs.documentation_only }}");
    assert.equal(job?.outputs?.draft_pull_request, "${{ steps.classify.outputs.draft_pull_request }}");
    assert.equal(job?.outputs?.lightweight_only, "${{ steps.classify.outputs.lightweight_only }}");
    assert.equal(job?.outputs?.package_only, "${{ steps.classify.outputs.package_only }}");
    assert.equal(
      job?.outputs?.release_infrastructure_only,
      "${{ steps.classify.outputs.release_infrastructure_only }}"
    );
    assert.equal(job?.outputs?.full_matrix_required, "${{ steps.classify.outputs.full_matrix_required }}");
    assert.deepEqual(job?.steps?.find((step) => step?.uses === "actions/checkout@v6")?.with, {
      "fetch-depth": 0
    });
    const step = job?.steps?.find((candidate) => candidate?.id === "classify");
    assert.equal(step?.run, "node scripts/ci-path-classification.mjs");
    assert.deepEqual(step?.env, classifierEnvironment);
  };

  const ci = loadWorkflow(".github/workflows/ci.yml");
  assertClassifier(ci, "CI change classification");
  assert.equal(ci?.jobs?.classify?.if, "${{ github.event_name == 'pull_request' }}");
  for (const jobId of FULL_MATRIX_CI_JOBS) {
    const job = ci?.jobs?.[jobId];
    const needs = Array.isArray(job?.needs) ? job.needs : [job?.needs];
    assert.equal(needs.includes("classify"), true, `${jobId} must consume the exact classifier result.`);
    assert.equal(needs.includes("fast-feedback"), true, `${jobId} must wait for static preflight.`);
    if (jobId === "contract-tests") {
      assert.equal(job?.if, CONTRACT_CI_IF, `${jobId} must start after static preflight.`);
    } else {
      assert.equal(needs.includes("contract-tests"), true, `${jobId} must wait for contract preflight.`);
      assert.equal(job?.if, FULL_CI_IF, `${jobId} must start only after both preflight lanes pass.`);
    }
    assert.equal(
      (job?.steps ?? []).some((step) => String(step?.if ?? "").includes("documentation_only")),
      false,
      `${jobId} must not duplicate documentation classification across individual steps.`
    );
  }
  const canonical = ci?.jobs?.[PACKAGE_CI_JOBS[0]];
  assert.equal(canonical?.if, CANONICAL_CI_IF);
  const packagedMedia = canonical?.steps?.find((step) => step?.name === "Packaged release-media contracts");
  assert.equal(packagedMedia?.if, "${{ needs.classify.outputs.package_only == 'true' }}");
  assert.equal(packagedMedia?.run, "npm run test:scripts:media");
  assert.equal(ci?.jobs?.["fast-feedback"]?.needs, undefined);
  assert.equal(ci?.jobs?.["fast-feedback"]?.if, undefined);

  const lockValidation = ci?.jobs?.[DEPENDENCY_LOCK_CI_JOBS[0]];
  assert.equal(lockValidation?.name, "Dependency lock validation");
  assert.deepEqual(lockValidation?.needs, ["classify", "fast-feedback"]);
  assert.match(lockValidation?.if ?? "", /dependency_lock_only == 'true'/u);
  assert.match(lockValidation?.if ?? "", /draft_pull_request == 'false'/u);
  assert.deepEqual(
    lockValidation?.steps?.filter((step) => typeof step?.run === "string").map((step) => step.run),
    ["npm ci", "npm ls", "npm audit", "npm run test:ts -- --exclude src/test/notebookVariableDiscovery.python.test.ts"]
  );

  for (const [relativePath, classifierName, expectedJobs] of [
    [
      ".github/workflows/cross-platform.yml",
      "Cross-platform change classification",
      {
        runtime: {
          name: undefined,
          matrix: {
            include: [
              { os: "macos-latest", python: "3.12" },
              { os: "windows-latest", python: "3.14" }
            ]
          }
        },
        "dependency-guard-windows": {
          name: "Dependency guard (Windows, Python ${{ matrix.python }})",
          matrix: { python: ["3.10", "3.12", "3.14"] }
        }
      }
    ],
    [
      ".github/workflows/codeql.yml",
      "CodeQL change classification",
      {
        analyze: {
          name: "Analyze (${{ matrix.language }})",
          matrix: { language: ["javascript-typescript", "python"] }
        }
      }
    ]
  ]) {
    const workflow = loadWorkflow(relativePath);
    assertClassifier(workflow, classifierName);
    for (const [jobId, expected] of Object.entries(expectedJobs)) {
      const job = workflow?.jobs?.[jobId];
      assert.equal(job?.needs, "classify");
      assert.equal(job?.if, MATRIX_CONTEXT_IF);
      assert.equal(job?.name, expected.name);
      assert.deepEqual(job?.strategy?.matrix, expected.matrix);
      const gate = job?.steps?.[0];
      assert.equal(gate?.name, "Require exact change classification");
      assert.equal(normalizedCommand(gate?.if), CLASSIFICATION_GATE_IF);
      assert.equal(gate?.run, "exit 1");
      const contextCarrier = job?.steps?.[1];
      assert.equal(contextCarrier?.name, "Preserve required non-matrix context");
      assert.equal(
        normalizedCommand(contextCarrier?.if),
        relativePath === ".github/workflows/codeql.yml" ? CODEQL_NON_MATRIX_CONTEXT_IF : NON_MATRIX_CONTEXT_IF
      );
      assert.match(contextCarrier?.run ?? "", /preserves? (?:its|this) required check context/u);
      for (const step of job?.steps?.slice(2) ?? []) {
        if (relativePath === ".github/workflows/codeql.yml") {
          assert.equal(normalizedCommand(step?.if), CODEQL_SUBSTANTIVE_MATRIX_STEP_IF);
        } else if (step?.run === "npm run test:scripts:native") {
          assert.match(normalizedCommand(step?.if) ?? "", /runner\.os == 'Windows'/u);
          assert.match(normalizedCommand(step?.if) ?? "", /full_matrix_required == 'true'/u);
        } else {
          assert.equal(normalizedCommand(step?.if), SUBSTANTIVE_MATRIX_STEP_IF);
        }
      }
    }
  }

  const codeqlSteps = loadWorkflow(".github/workflows/codeql.yml")?.jobs?.analyze?.steps;
  assert.equal(codeqlSteps?.length, 5, "Each required CodeQL cell must retain one gate/carrier/analysis shape.");
  assert.equal(codeqlSteps?.[0]?.name, "Require exact change classification");
  assert.equal(codeqlSteps?.[1]?.name, "Preserve required non-matrix context");
  assert.equal(codeqlSteps?.[2]?.uses, "actions/checkout@v6");
  assert.equal(codeqlSteps?.[3]?.uses, "github/codeql-action/init@v4");
  assert.equal(codeqlSteps?.[4]?.uses, "github/codeql-action/analyze@v4");
  assert.equal(normalizedCommand(codeqlSteps?.[1]?.if), CODEQL_NON_MATRIX_CONTEXT_IF);
  for (const step of codeqlSteps?.slice(2) ?? []) {
    assert.equal(normalizedCommand(step?.if), CODEQL_SUBSTANTIVE_MATRIX_STEP_IF);
  }
  assert.deepEqual(codeqlSteps?.[3]?.with, {
    "config-file": "./.github/codeql-config.yml",
    languages: "${{ matrix.language }}",
    queries: "security-extended"
  });
  assert.deepEqual(codeqlSteps?.[4]?.with, { category: "/language:${{ matrix.language }}" });

  const nativeRuntime = loadWorkflow(".github/workflows/cross-platform.yml")?.jobs?.runtime;
  assert.equal(nativeRuntime?.["timeout-minutes"], 60);
  assert.equal(
    nativeRuntime?.steps?.some((step) => step?.run === "npm run test:extension-host"),
    true,
    "The existing macOS/Windows runtime cells must also own native extension-host coverage."
  );
  assert.equal(
    nativeRuntime?.steps?.find((step) => step?.run === "npm run test:extension-host")?.env?.VSCODE_TEST_VERSION,
    "stable",
    "Cross-platform extension-host coverage must pin the current stable VS Code build."
  );
  assert.equal(
    nativeRuntime?.steps?.filter((step) => step?.run === "npm run test:scripts:native").length,
    1,
    "Windows native script contracts must run once in the existing Windows cell."
  );
});

test("ready validation stays fail-closed while drafts report separate feedback", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const aggregate = workflow?.jobs?.validate;

  assert.equal(
    aggregate?.name,
    "${{ github.event.pull_request.draft && 'Draft feedback' || 'validate' }}",
    "A draft must not publish the protected validate context at the same commit."
  );
  assert.deepEqual(REQUIRED_CI_JOBS, EXPECTED_BLOCKING_CI_JOBS);
  assert.deepEqual(aggregate?.needs, [...EXPECTED_BLOCKING_CI_JOBS, OPTIONAL_CI_JOB]);
  assert.equal(aggregate?.if, "${{ !cancelled() && github.event_name == 'pull_request' }}");
  assert.equal(aggregate?.["runs-on"], "ubuntu-latest");
  assert.equal(aggregate?.["timeout-minutes"], 5);
  assert.equal(aggregate?.["continue-on-error"], undefined);

  const resultStep = aggregate?.steps?.find((step) => step?.run === "node scripts/require-ci-results.mjs");
  assert.ok(resultStep);
  assert.equal(resultStep?.["continue-on-error"], undefined);
  for (const jobId of EXPECTED_BLOCKING_CI_JOBS) {
    assert.equal(resultStep?.env?.[resultEnvironmentKey(jobId)], `\${{ needs.${jobId}.result }}`);
  }
  assert.equal(resultStep?.env?.BENCHMARK_HARNESS_ONLY, "${{ needs.classify.outputs.benchmark_harness_only }}");
  assert.equal(resultStep?.env?.DOCUMENTATION_ONLY, "${{ needs.classify.outputs.documentation_only }}");
  assert.equal(resultStep?.env?.DEPENDENCY_LOCK_ONLY, "${{ needs.classify.outputs.dependency_lock_only }}");
  assert.equal(resultStep?.env?.DRAFT_PULL_REQUEST, "${{ needs.classify.outputs.draft_pull_request }}");
  assert.equal(resultStep?.env?.LIGHTWEIGHT_ONLY, "${{ needs.classify.outputs.lightweight_only }}");
  assert.equal(resultStep?.env?.PACKAGE_ONLY, "${{ needs.classify.outputs.package_only }}");
  assert.equal(
    resultStep?.env?.RELEASE_INFRASTRUCTURE_ONLY,
    "${{ needs.classify.outputs.release_infrastructure_only }}"
  );
  assert.equal(resultStep?.env?.FULL_MATRIX_REQUIRED, "${{ needs.classify.outputs.full_matrix_required }}");
  assert.equal(resultStep?.env?.[resultEnvironmentKey(OPTIONAL_CI_JOB)], "${{ needs.remote-workspace.result }}");
  assert.match(resultStep?.env?.REMOTE_WORKSPACE_REQUIRED ?? "", /acceptance:remote-ssh/u);
});

test("required CI result validation rejects every absent or non-success blocking result", () => {
  const fullMatrixResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...BENCHMARK_HARNESS_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...DEPENDENCY_LOCK_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...RELEASE_INFRASTRUCTURE_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "success"])
  ]);
  const documentationResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...PRODUCT_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const packageResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...BENCHMARK_HARNESS_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...DEPENDENCY_LOCK_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...RELEASE_INFRASTRUCTURE_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const dependencyLockResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...BENCHMARK_HARNESS_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...DEPENDENCY_LOCK_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...RELEASE_INFRASTRUCTURE_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const benchmarkHarnessResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...BENCHMARK_HARNESS_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...DEPENDENCY_LOCK_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...RELEASE_INFRASTRUCTURE_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const releaseInfrastructureResults = Object.fromEntries([
    ...ALWAYS_REQUIRED_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...BENCHMARK_HARNESS_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...DEPENDENCY_LOCK_CI_JOBS.map((jobId) => [jobId, "skipped"]),
    ...RELEASE_INFRASTRUCTURE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...PACKAGE_CI_JOBS.map((jobId) => [jobId, "success"]),
    ...FULL_MATRIX_CI_JOBS.map((jobId) => [jobId, "skipped"])
  ]);
  const validateResults = (configuration) => {
    const normalized = {
      benchmarkHarnessOnly: false,
      dependencyLockOnly: false,
      draftPullRequest: false,
      packageOnly: false,
      releaseInfrastructureOnly: false,
      ...configuration
    };
    normalized.lightweightOnly ??= normalized.documentationOnly || normalized.draftPullRequest;
    normalized.fullMatrixRequired ??=
      !normalized.benchmarkHarnessOnly &&
      !normalized.documentationOnly &&
      !normalized.packageOnly &&
      !normalized.dependencyLockOnly &&
      !normalized.releaseInfrastructureOnly &&
      !normalized.draftPullRequest;
    return requireCiResults(normalized);
  };
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: benchmarkHarnessResults,
      benchmarkHarnessOnly: true,
      documentationOnly: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: fullMatrixResults,
      documentationOnly: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: documentationResults,
      documentationOnly: true,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: packageResults,
      documentationOnly: false,
      packageOnly: true,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: dependencyLockResults,
      dependencyLockOnly: true,
      documentationOnly: false,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: releaseInfrastructureResults,
      documentationOnly: false,
      releaseInfrastructureOnly: true,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: fullMatrixResults,
      documentationOnly: false,
      remoteResult: "success",
      remoteRequired: true
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: documentationResults,
      documentationOnly: false,
      draftPullRequest: true,
      lightweightOnly: true,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  assert.doesNotThrow(() =>
    validateResults({
      requiredResults: documentationResults,
      documentationOnly: false,
      draftPullRequest: true,
      packageOnly: true,
      remoteResult: "skipped",
      remoteRequired: false
    })
  );
  for (const [documentationOnly, draftPullRequest, lightweightOnly] of [
    [false, false, true],
    [true, false, false],
    [false, true, false],
    [true, true, false]
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          documentationOnly,
          draftPullRequest,
          lightweightOnly,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      /lightweight classifier is inconsistent/u
    );
  }
  for (const configuration of [
    {
      benchmarkHarnessOnly: true,
      documentationOnly: false,
      packageOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      documentationOnly: true,
      packageOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      dependencyLockOnly: true,
      documentationOnly: false,
      packageOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      documentationOnly: false,
      packageOnly: true,
      releaseInfrastructureOnly: true,
      fullMatrixRequired: false,
      message: /classifiers are mutually exclusive/u
    },
    {
      documentationOnly: false,
      releaseInfrastructureOnly: true,
      fullMatrixRequired: true,
      message: /full-matrix classifier is inconsistent/u
    },
    {
      documentationOnly: false,
      packageOnly: true,
      fullMatrixRequired: true,
      message: /full-matrix classifier is inconsistent/u
    },
    {
      documentationOnly: false,
      packageOnly: false,
      fullMatrixRequired: false,
      message: /full-matrix classifier is inconsistent/u
    }
  ]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          benchmarkHarnessOnly: configuration.benchmarkHarnessOnly ?? false,
          dependencyLockOnly: configuration.dependencyLockOnly ?? false,
          documentationOnly: configuration.documentationOnly,
          packageOnly: configuration.packageOnly,
          releaseInfrastructureOnly: configuration.releaseInfrastructureOnly ?? false,
          fullMatrixRequired: configuration.fullMatrixRequired,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      configuration.message
    );
  }

  for (const jobId of BENCHMARK_HARNESS_CI_JOBS) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...benchmarkHarnessResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            benchmarkHarnessOnly: true,
            documentationOnly: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected success\\)`, "u")
      );
    }
  }

  for (const jobId of [...ALWAYS_REQUIRED_CI_JOBS, ...PACKAGE_CI_JOBS, ...FULL_MATRIX_CI_JOBS]) {
    for (const result of [undefined, "failure", "cancelled", "skipped"]) {
      const candidate = { ...fullMatrixResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"}`, "u")
      );
    }
  }

  for (const jobId of DEPENDENCY_LOCK_CI_JOBS) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...dependencyLockResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            dependencyLockOnly: true,
            documentationOnly: false,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected success\\)`, "u")
      );
    }
  }

  for (const jobId of RELEASE_INFRASTRUCTURE_CI_JOBS) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...releaseInfrastructureResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            releaseInfrastructureOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected success\\)`, "u")
      );
    }
  }
  for (const jobId of [...BENCHMARK_HARNESS_CI_JOBS, ...DEPENDENCY_LOCK_CI_JOBS, ...FULL_MATRIX_CI_JOBS]) {
    for (const result of [undefined, "success", "failure", "cancelled"]) {
      const candidate = { ...releaseInfrastructureResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            releaseInfrastructureOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected skipped\\)`, "u")
      );
    }
  }
  for (const jobId of [...ALWAYS_REQUIRED_CI_JOBS, ...PACKAGE_CI_JOBS]) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...releaseInfrastructureResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            releaseInfrastructureOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"}`, "u")
      );
    }
  }

  for (const jobId of ALWAYS_REQUIRED_CI_JOBS) {
    const candidate = { ...documentationResults, [jobId]: "skipped" };
    assert.throws(
      () =>
        validateResults({
          requiredResults: candidate,
          documentationOnly: true,
          remoteResult: "skipped",
          remoteRequired: false
        }),
      new RegExp(`${jobId}=skipped`, "u")
    );
  }
  for (const jobId of PRODUCT_CI_JOBS) {
    for (const result of [undefined, "success", "failure", "cancelled"]) {
      const candidate = { ...documentationResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected skipped\\)`, "u")
      );
    }
  }
  for (const jobId of PACKAGE_CI_JOBS) {
    for (const result of [undefined, "skipped", "failure", "cancelled"]) {
      const candidate = { ...packageResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            packageOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected success\\)`, "u")
      );
    }
  }
  for (const jobId of FULL_MATRIX_CI_JOBS) {
    for (const result of [undefined, "success", "failure", "cancelled"]) {
      const candidate = { ...packageResults };
      if (result === undefined) delete candidate[jobId];
      else candidate[jobId] = result;
      assert.throws(
        () =>
          validateResults({
            requiredResults: candidate,
            documentationOnly: false,
            packageOnly: true,
            remoteResult: "skipped",
            remoteRequired: false
          }),
        new RegExp(`${jobId}=${result ?? "missing"} \\(expected skipped\\)`, "u")
      );
    }
  }
  for (const inconsistent of [{ remoteRequired: true, message: /remote-workspace classifier is inconsistent/u }]) {
    assert.throws(
      () =>
        validateResults({
          requiredResults: documentationResults,
          documentationOnly: true,
          remoteResult: "skipped",
          remoteRequired: inconsistent.remoteRequired
        }),
      inconsistent.message
    );
  }

  assert.throws(
    () =>
      validateResults({
        requiredResults: fullMatrixResults,
        documentationOnly: false,
        remoteResult: "skipped",
        remoteRequired: true
      }),
    /remote-workspace=skipped \(expected success\)/u
  );
  assert.throws(
    () =>
      validateResults({
        requiredResults: fullMatrixResults,
        documentationOnly: false,
        remoteResult: "success",
        remoteRequired: false
      }),
    /remote-workspace=success \(expected skipped\)/u
  );
  assert.equal(parseRequiredFlag("true", "TEST_REQUIRED"), true);
  assert.equal(parseRequiredFlag("false", "TEST_REQUIRED"), false);
  for (const value of [undefined, "", "TRUE", "False", "0", "1"]) {
    assert.throws(() => parseRequiredFlag(value, "TEST_REQUIRED"), /TEST_REQUIRED must be exactly true or false/u);
  }
});

test("opt-in Remote SSH acceptance consumes the same canonical VSIX once", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["remote-workspace"];
  assert.deepEqual(job?.needs, ["classify", "fast-feedback", "contract-tests", "canonical-vsix"]);
  assert.equal(job?.["runs-on"], "ubuntu-24.04");
  assert.equal(job?.["timeout-minutes"], 90);
  assert.match(job?.if ?? "", /!cancelled\(\)/u);
  assert.match(job?.if ?? "", /needs\.fast-feedback\.result == 'success'/u);
  assert.match(job?.if ?? "", /needs\.contract-tests\.result == 'success'/u);
  assert.match(job?.if ?? "", /needs\.classify\.outputs\.full_matrix_required == 'true'/u);
  assert.match(job?.if ?? "", /github\.event_name == 'pull_request'/u);
  assert.match(job?.if ?? "", /contains\(github\.event\.pull_request\.labels\.\*\.name, 'acceptance:remote-ssh'\)/u);

  const steps = job?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the opt-in Remote SSH acceptance job.");
  const prerequisite = steps.find((step) => step?.name === "Require the canonical PR artifact");
  assert.match(prerequisite?.if ?? "", /needs\.canonical-vsix\.result != 'success'/u);
  assert.equal(prerequisite?.run, "exit 1");

  const host = steps.find((step) => step?.name === "Prepare namespace-capable acceptance host");
  assert.match(host?.run ?? "", /kernel\.apparmor_restrict_unprivileged_userns=0/u);
  assert.match(host?.run ?? "", /kernel\.unprivileged_userns_clone=1/u);
  assert.match(host?.run ?? "", /user\.max_user_namespaces/u);
  assert.match(host?.run ?? "", /coreutils/u);
  assert.match(host?.run ?? "", /libtomcrypt1/u);
  assert.match(host?.run ?? "", /libtommath1/u);
  assert.match(host?.run ?? "", /procps/u);
  assert.equal((host?.run ?? "").includes('runner_uid="$(id -u)"'), true);
  assert.equal((host?.run ?? "").includes('test "$owner" = "0" || test "$owner" = "$runner_uid"'), true);
  assert.equal(
    (host?.run ?? "").includes('sudo chown --no-dereference root:root -- "${system_runtime_ancestors[@]}"'),
    true
  );
  assert.equal((host?.run ?? "").includes('sudo chmod go-w -- "${system_runtime_ancestors[@]}"'), true);
  assert.equal((host?.run ?? "").includes('for directory in / "${system_runtime_ancestors[@]}"; do'), true);
  assert.equal((host?.run ?? "").includes(`test "$(stat --format='%u:%g' "$directory")" = "0:0"`), true);
  assert.equal((host?.run ?? "").includes(`find "$directory" -maxdepth 0 -perm /022 -print -quit`), true);
  assert.equal((host?.run ?? "").includes('test ! -w "$directory"'), true);
  const ancestors = /system_runtime_ancestors=\(\n(?<ancestors>(?: {2}\/[^\n]+\n)+)\)\n/u.exec(host?.run ?? "");
  assert.ok(ancestors?.groups?.ancestors, "Remote SSH CI must retain one explicit system-ancestor array.");
  assert.deepEqual(
    ancestors.groups.ancestors
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    ["/usr", "/etc"]
  );
  assert.equal((host?.run ?? "").includes("sudo chmod go-w -- /usr/share"), true);
  assert.equal((host?.run ?? "").includes("test ! -w /usr/share"), true);
  assert.equal((host?.run ?? "").includes('sudo chmod --recursive go-w -- "${system_runtime_roots[@]}"'), true);
  assert.equal((host?.run ?? "").includes('find "$directory" -xdev'), true);
  assert.equal((host?.run ?? "").includes("! -user root -print -quit"), true);
  assert.equal((host?.run ?? "").includes("-perm /022 -print -quit"), true);
  assert.equal((host?.run ?? "").includes("! -type d ! -type f ! -type l -print -quit"), true);
  const roots = /system_runtime_roots=\(\n(?<roots>(?: {2}\/[^\n]+\n)+)\)\n/u.exec(host?.run ?? "");
  assert.ok(roots?.groups?.roots, "Remote SSH CI must retain one explicit system-runtime root array.");
  assert.deepEqual(
    roots.groups.roots
      .trim()
      .split("\n")
      .map((line) => line.trim()),
    [
      "/usr/share/fontconfig",
      "/usr/share/fonts",
      "/usr/share/glib-2.0",
      "/usr/share/icons",
      "/usr/share/mime",
      "/usr/share/X11",
      "/usr/share/zoneinfo"
    ]
  );
  assert.ok(
    steps.some((step) => step?.run === ".remote-venv/bin/python -m pip install ./python"),
    "Remote SSH CI must install one self-contained runtime environment."
  );

  const download = steps.find(
    (step) => typeof step?.uses === "string" && step.uses.startsWith("actions/download-artifact@")
  );
  assert.equal(download?.with?.name, "openwrangler-vsix");
  assert.equal(download?.with?.path, "canonical-vsix");

  const candidate = steps.find((step) => step?.id === "candidate");
  assert.match(candidate?.run ?? "", /resolve\("canonical-vsix\/openwrangler\.vsix"\)/u);
  assert.match(candidate?.run ?? "", /path=\$\{candidatePath\}/u);
  assert.match(candidate?.run ?? "", /openwrangler\.vsix\.sha256/u);
  assert.match(candidate?.run ?? "", /GITHUB_OUTPUT/u);

  const acceptance = steps.find((step) => step?.id === "remote_workspace");
  assert.match(acceptance?.run ?? "", /^npm run test:remote-workspace --/u);
  assert.match(acceptance?.run ?? "", /steps\.candidate\.outputs\.path/u);
  assert.equal(acceptance?.env?.OPEN_WRANGLER_EDITOR_DISPLAY, "xvfb");
  assert.equal(acceptance?.env?.OPEN_WRANGLER_REMOTE_PYTHON, "${{ github.workspace }}/.remote-venv/bin/python");
  assert.equal(steps.filter((step) => String(step?.run ?? "").includes("npm run test:remote-workspace --")).length, 1);
});

test("draft feedback uses a different context before same-SHA ready validation", () => {
  for (const relativePath of requiredPullRequestWorkflows) {
    const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const workflow = parseYaml(source);
    assert.match(source, /\non:\n {2}pull_request:/u, `${relativePath} must retain its pull-request trigger.`);
    assert.deepEqual(
      workflow?.on?.pull_request?.types,
      PULL_REQUEST_ACTIVITY_TYPES,
      `${relativePath} must rerun when the same head becomes ready or returns to draft.`
    );
    const classify = workflow?.jobs?.classify?.steps?.find((step) => step?.id === "classify");
    assert.equal(classify?.env?.CI_PR_DRAFT, "${{ github.event.pull_request.draft }}");
  }
  const ci = parseYaml(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
  assert.equal(ci?.jobs?.validate?.name, "${{ github.event.pull_request.draft && 'Draft feedback' || 'validate' }}");
  const aggregateSource = readFileSync(new URL("./require-ci-results.mjs", import.meta.url), "utf8");
  assert.match(aggregateSource, /Draft feedback passed/u);
});

test("routine Dependabot work is grouped, bounded, and staggered without grouping security updates", () => {
  const source = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.equal(
    source,
    `version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 4
    groups:
      npm-minor-patch:
        applies-to: version-updates
        patterns:
          - "*"
        exclude-patterns:
          - "@types/vscode"
          - "playwright-core"
        update-types:
          - minor
          - patch
    ignore:
      - dependency-name: "@types/vscode"
  - package-ecosystem: pip
    directory: /python
    schedule:
      interval: weekly
      day: tuesday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 4
    groups:
      python-minor-patch:
        applies-to: version-updates
        patterns:
          - "*"
        update-types:
          - minor
          - patch
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: wednesday
      time: "03:17"
      timezone: Etc/UTC
    open-pull-requests-limit: 3
    groups:
      actions-minor-patch:
        applies-to: version-updates
        patterns:
          - "*"
        update-types:
          - minor
          - patch
`
  );
});

test("required Linux Python 3.10 owns real discovery while cross-platform keeps distinct native cells", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["python-matrix"];
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.deepEqual(job?.strategy?.matrix?.python, ["3.10", "3.14"]);
  assert.equal(job?.env, undefined, "The real-discovery job must not inject an interpreter override.");

  const steps = job?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the required Python compatibility matrix.");
  const python310Only = "matrix.python == '3.10'";
  const node = steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-node@"));
  assert.equal(node?.if, python310Only);
  assert.equal(node?.with?.["node-version"], 22);
  assert.equal(node?.with?.cache, "npm");

  const npmInstall = steps.find((step) => step?.run === "npm ci");
  assert.equal(npmInstall?.if, python310Only);
  assert.equal(npmInstall?.env, undefined);
  const environmentSmoke = steps.find((step) => step?.run === "npm run test:python-environment-smoke");
  assert.equal(environmentSmoke?.if, python310Only);
  assert.equal(environmentSmoke?.env, undefined);

  const duckdbMinimum = steps.find(
    (step) => step?.run === 'python -m pip install --force-reinstall --no-deps "duckdb==1.5.4"'
  );
  assert.equal(duckdbMinimum?.name, "Pin the declared DuckDB minimum");
  assert.equal(duckdbMinimum?.if, "matrix.python == '3.14'");

  const runtimeSuite = steps.filter((step) => step?.run === "python -m pytest python/tests -q");
  assert.equal(runtimeSuite.length, 1);
  assert.equal(runtimeSuite[0]?.if, undefined, "The runtime suite must execute on both matrix cells.");

  const crossPlatformSource = readFileSync(new URL("../.github/workflows/cross-platform.yml", import.meta.url), "utf8");
  const crossPlatform = parseYaml(crossPlatformSource);
  assert.deepEqual(crossPlatform?.jobs?.runtime?.strategy?.matrix?.include, [
    { os: "macos-latest", python: "3.12" },
    { os: "windows-latest", python: "3.14" }
  ]);
});

test("native R contracts run only in the focused R 4.4 and 4.5 matrix", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  const job = workflow?.jobs?.["native-r-contract"];

  assert.equal(job?.name, "Native R contract (R ${{ matrix.r }})");
  assert.deepEqual(job?.needs, ["classify", "fast-feedback", "contract-tests"]);
  assert.equal(job?.if, FULL_CI_IF);
  assert.equal(job?.["runs-on"], "ubuntu-latest");
  assert.equal(job?.["timeout-minutes"], 15);
  assert.deepEqual(job?.strategy, { "fail-fast": false, matrix: { r: ["4.4", "4.5"] } });

  const setup = job?.steps?.find((step) => step?.uses === SETUP_R_ACTION);
  assert.deepEqual(setup?.with, { "r-version": "${{ matrix.r }}", "use-public-rspm": true });
  const dependencies = job?.steps?.filter((step) => step?.uses === SETUP_R_DEPENDENCIES_ACTION);
  assert.equal(dependencies?.length, 1, "The focused R matrix must restore its contract packages once.");
  assert.equal(dependencies[0]?.name, "Restore R contract packages");
  assert.deepEqual(dependencies[0]?.with, {
    packages: "",
    "extra-packages": [
      "any::jsonlite",
      "any::tibble",
      "any::readr",
      "any::dplyr",
      "any::data.table",
      "any::bit64",
      "any::collapse",
      "any::nanoparquet"
    ].join("\n"),
    dependencies: '"hard"',
    cache: true,
    "cache-version": "native-r-contract-v1",
    "install-pandoc": false,
    "install-quarto": false
  });
  assert.equal(
    job?.steps?.filter((step) => step?.run === "npm run test:r-contract").length,
    1,
    "The focused R matrix must own the cross-language contract exactly once."
  );
  for (const [jobId, candidate] of Object.entries(workflow?.jobs ?? {})) {
    if (jobId === "native-r-contract") continue;
    assert.equal(
      candidate?.steps?.some(
        (step) =>
          step?.uses === SETUP_R_ACTION ||
          step?.uses === SETUP_R_DEPENDENCIES_ACTION ||
          step?.run === "npm run test:r-contract"
      ),
      false,
      `${jobId} must not install or execute R contract tooling.`
    );
  }
});

test("native R contract child budgets separate exact R from Vitest", () => {
  const runnerSource = readFileSync(new URL("./run-r-contract-tests.mjs", import.meta.url), "utf8");

  assert.match(runnerSource, /const DIRECT_R_CONTRACT_TIMEOUT_MS = 300_000;/u);
  assert.match(runnerSource, /const VITEST_CONTRACT_TIMEOUT_MS = 120_000;/u);
  assert.equal(
    runnerSource.match(/timeoutMs: DIRECT_R_CONTRACT_TIMEOUT_MS/gu)?.length,
    2,
    "both direct R contract subprocesses must use the named 300-second bound"
  );
  assert.equal(
    runnerSource.match(/timeoutMs: VITEST_CONTRACT_TIMEOUT_MS/gu)?.length,
    1,
    "the Vitest subprocess must retain its explicit 120-second bound"
  );
  assert.match(runnerSource, /timeout: timeoutMs,/u);
  assert.doesNotMatch(runnerSource, /timeout:\s*(?:120_000|300_000),/u);
});

test("coverage provisions the exact PySpark runtime before enforcing the unchanged floor", () => {
  const source = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const workflow = parseYaml(source);
  const steps = workflow?.jobs?.coverage?.steps;
  assert.ok(Array.isArray(steps), "CI must retain the required coverage job.");

  const java = steps.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-java@"));
  assert.deepEqual(java?.with, {
    distribution: "temurin",
    "java-version": "17"
  });
  const install = steps.find(
    (step) => step?.run === 'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"'
  );
  assert.ok(install);
  const verification = steps.find((step) => step?.name === "Verify exact coverage runtimes");
  assert.equal(verification?.shell, "bash");
  assert.match(verification?.run ?? "", /pyspark\.__version__ == "4\.2\.0"/u);
  assert.match(verification?.run ?? "", /Version\("2\.2"\).*Version\("3"\)/u);
  assert.match(verification?.run ?? "", /java\\\.specification\\\.version = 17/u);

  const coverage = steps.find((step) => step?.run === "npm run test:coverage");
  assert.ok(coverage);
  assert.ok(steps.indexOf(java) < steps.indexOf(coverage));
  assert.ok(steps.indexOf(install) < steps.indexOf(coverage));
  assert.ok(steps.indexOf(verification) < steps.indexOf(coverage));
  assert.equal(manifest?.scripts?.["test:coverage"], "npm run test:coverage:run");
  assert.equal(
    manifest?.scripts?.["test:coverage:run"],
    "npm run test:coverage:ts && npm run test:coverage:python",
    "Coverage must continue to own both complete instrumented suites."
  );
  assert.equal(manifest?.scripts?.["test:coverage:ts"], "vitest run --coverage");
  assert.match(manifest?.scripts?.["test:coverage:python"] ?? "", /pytest python\/tests .*--cov=openwrangler_runtime/u);
});

test("standalone released-Jupyter acceptance is manual-only and self-packages", () => {
  const source = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(
    inspectDeferredDiagnosticFailures(workflow, "actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f"),
    []
  );
  assert.deepEqual(Object.keys(workflow?.on ?? {}), ["workflow_dispatch"]);
  assert.equal(workflow?.on?.pull_request, undefined);
  assert.deepEqual(workflow?.on?.workflow_dispatch?.inputs?.target, {
    description: "Acceptance lane to run",
    required: true,
    default: "linux-all",
    type: "choice",
    options: ["linux-all", "macos-r", "windows-r"]
  });
  assert.deepEqual(workflow?.concurrency, {
    group: "released-jupyter-${{ github.ref }}-${{ inputs.target }}",
    "cancel-in-progress": true
  });
  const job = workflow?.jobs?.vscode;
  assert.equal(job?.name, "Released Jupyter in VS Code and Cursor");
  assert.equal(job?.if, "${{ inputs.target == 'linux-all' }}");
  assert.equal(job?.["timeout-minutes"], 90);
  assertStandaloneReleasedJupyterRTriples(workflow);
  const linuxPackageCommand = "npm run clean && npm run build && npm run package:prepared -- --out openwrangler.vsix";
  const linuxPackageIndex = job?.steps?.findIndex((step) => step?.run === linuxPackageCommand) ?? -1;
  const linuxVerifyIndex =
    job?.steps?.findIndex((step) => step?.run === "npm run verify:vsix -- openwrangler.vsix") ?? -1;
  const linuxTestExtensionIndex = job?.steps?.findIndex((step) => step?.run === "npm run build:test-extension") ?? -1;
  assert.ok(linuxPackageIndex >= 0, "Released-Jupyter acceptance must package the explicit clean production build.");
  assert.ok(linuxVerifyIndex > linuxPackageIndex, "Released-Jupyter acceptance must verify the freshly packaged VSIX.");
  assert.ok(
    linuxTestExtensionIndex > linuxVerifyIndex,
    "Released-Jupyter acceptance must build its test driver only after VSIX verification."
  );
  assert.doesNotMatch(
    source,
    /npm run package -- --out openwrangler\.vsix/u,
    "The focused Released-Jupyter workflow must not rerun the full source suite through npm run package."
  );
  assert.doesNotMatch(source, /npm run package -- --pre-release/u);
  assert.equal(
    job?.steps?.some((step) => step?.run === 'python -m pip install -e "python[dev]"'),
    true
  );
  assert.deepEqual(
    job?.steps?.find((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/setup-java@"))?.with,
    {
      distribution: "temurin",
      "java-version": "17"
    }
  );
  assert.deepEqual(job?.steps?.find((step) => step?.uses === SETUP_R_ACTION)?.with, {
    "r-version": "4.5.2",
    "use-public-rspm": true
  });
  const rscript = job?.steps?.find((step) => step?.id === "rscript");
  assert.equal(rscript?.name, "Locate hosted Rscript");
  assert.equal(rscript?.shell, "bash");
  assert.match(rscript?.run ?? "", /rscript="\$\(command -v Rscript\)"/u);
  assert.match(rscript?.run ?? "", /printf 'executable=%s\\n' "\$rscript" >> "\$GITHUB_OUTPUT"/u);
  assert.match(rscript?.run ?? "", /r_version="\$\(Rscript --vanilla -e 'cat\(as\.character\(getRversion\(\)\)\)'\)"/u);
  assert.match(rscript?.run ?? "", /printf 'version=%s\\n' "\$r_version" >> "\$GITHUB_OUTPUT"/u);
  const packaged = job?.steps?.find((step) => step?.id === "packaged_editor");
  assert.equal(packaged?.name, "Test remote Python Jupyter in packaged VS Code");
  assert.equal(
    packaged?.run,
    "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix"
  );
  assert.deepEqual(packaged?.env, {
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
    VSCODE_TEST_VERSION: "stable"
  });
  const diagnostics = job?.steps?.find((step) => step?.name === "Upload packaged-editor failure diagnostics");
  assert.equal(
    diagnostics?.with?.name,
    "released-jupyter-python-diagnostics-vscode-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(diagnostics?.with?.path, "${{ steps.packaged_editor.outputs.evidence_path }}");

  const coreRVerifier = job?.steps?.find((step) => step?.id === "canonical_r_jupyter");
  const packagedR = job?.steps?.find((step) => step?.id === "packaged_editor_r");
  assert.deepEqual(coreRVerifier, {
    id: "canonical_r_jupyter",
    name: "Reverify the VSIX for core R operations",
    run: "npm run verify:vsix -- openwrangler.vsix"
  });
  assert.equal(packagedR?.name, "Test released R Jupyter in packaged VS Code and Cursor");
  assert.equal(packagedR?.["continue-on-error"], true);
  assert.equal(
    packagedR?.run,
    "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix"
  );
  assert.deepEqual(packagedR?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  const rDiagnostics = job?.steps?.find((step) => step?.name === "Upload packaged-editor R failure diagnostics");
  assert.equal(
    rDiagnostics?.if,
    "${{ always() && steps.packaged_editor_r.outcome == 'failure' && steps.packaged_editor_r.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(
    rDiagnostics?.with?.name,
    "released-jupyter-r-diagnostics-editors-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(rDiagnostics?.with?.path, "${{ steps.packaged_editor_r.outputs.evidence_path }}");
  const coreRVerifierIndex = job?.steps?.indexOf(coreRVerifier) ?? -1;
  const packagedRIndex = job?.steps?.indexOf(packagedR) ?? -1;
  const rDiagnosticsIndex = job?.steps?.indexOf(rDiagnostics) ?? -1;
  const valueRVerifier = job?.steps?.find((step) => step?.id === "canonical_r_values");
  const valueRRunner = job?.steps?.find((step) => step?.id === "packaged_editor_r_values");
  const valueRDiagnostics = job?.steps?.find((step) => step?.name === "Upload value R-Jupyter failure diagnostics");
  const valueRVerifierIndex = job?.steps?.indexOf(valueRVerifier) ?? -1;
  const valueRRunnerIndex = job?.steps?.indexOf(valueRRunner) ?? -1;
  const valueRDiagnosticsIndex = job?.steps?.indexOf(valueRDiagnostics) ?? -1;
  const categoricalRVerifier = job?.steps?.find((step) => step?.id === "canonical_r_categorical");
  const categoricalRRunner = job?.steps?.find((step) => step?.id === "packaged_editor_r_categorical");
  const categoricalRDiagnostics = job?.steps?.find(
    (step) => step?.name === "Upload categorical R-Jupyter failure diagnostics"
  );
  const categoricalRVerifierIndex = job?.steps?.indexOf(categoricalRVerifier) ?? -1;
  const categoricalRRunnerIndex = job?.steps?.indexOf(categoricalRRunner) ?? -1;
  const categoricalRDiagnosticsIndex = job?.steps?.indexOf(categoricalRDiagnostics) ?? -1;
  assert.equal(
    valueRVerifier?.run,
    "npm run verify:vsix -- openwrangler.vsix",
    "Focused value acceptance must freshly reverify the packaged VSIX."
  );
  assert.equal(packagedRIndex, coreRVerifierIndex + 1);
  assert.equal(rDiagnosticsIndex, packagedRIndex + 1);
  assert.equal(valueRVerifierIndex, rDiagnosticsIndex + 1);
  assert.equal(valueRRunnerIndex, valueRVerifierIndex + 1);
  assert.equal(valueRDiagnosticsIndex, valueRRunnerIndex + 1);
  assert.equal(valueRRunner?.["continue-on-error"], true);
  assert.equal(
    valueRRunner?.run,
    "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix"
  );
  assert.deepEqual(valueRRunner?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_R_JOURNEY: "value-operations",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  assert.equal(
    valueRDiagnostics?.if,
    "${{ always() && steps.packaged_editor_r_values.outcome == 'failure' && steps.packaged_editor_r_values.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(
    valueRDiagnostics?.with?.name,
    "released-jupyter-r-values-diagnostics-editors-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(valueRDiagnostics?.with?.path, "${{ steps.packaged_editor_r_values.outputs.evidence_path }}");
  assert.equal(
    categoricalRVerifier?.run,
    "npm run verify:vsix -- openwrangler.vsix",
    "Focused categorical acceptance must freshly reverify the packaged VSIX."
  );
  assert.equal(categoricalRVerifierIndex, valueRDiagnosticsIndex + 1);
  assert.equal(categoricalRRunnerIndex, categoricalRVerifierIndex + 1);
  assert.equal(categoricalRDiagnosticsIndex, categoricalRRunnerIndex + 1);
  assert.equal(categoricalRRunner?.["continue-on-error"], true);
  assert.equal(
    categoricalRRunner?.run,
    "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix"
  );
  assert.deepEqual(categoricalRRunner?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_R_JOURNEY: "categorical-operations",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  assert.equal(
    categoricalRDiagnostics?.if,
    "${{ always() && steps.packaged_editor_r_categorical.outcome == 'failure' && steps.packaged_editor_r_categorical.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(
    categoricalRDiagnostics?.with?.name,
    "released-jupyter-r-categorical-diagnostics-editors-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(categoricalRDiagnostics?.with?.path, "${{ steps.packaged_editor_r_categorical.outputs.evidence_path }}");
  const interactiveRVerifier = job?.steps?.find((step) => step?.id === "canonical_r_interactive");
  const interactiveRRunner = job?.steps?.find((step) => step?.id === "packaged_editor_r_interactive");
  const interactiveRVerifierIndex = job?.steps?.indexOf(interactiveRVerifier) ?? -1;
  const interactiveRRunnerIndex = job?.steps?.indexOf(interactiveRRunner) ?? -1;
  assert.equal(interactiveRVerifierIndex, categoricalRDiagnosticsIndex + 1);
  assert.equal(
    interactiveRVerifier?.run,
    "npm run verify:vsix -- openwrangler.vsix",
    "Focused active-R acceptance must freshly reverify the packaged VSIX."
  );
  assert.equal(
    interactiveRRunnerIndex,
    interactiveRVerifierIndex + 1,
    "Focused active-R acceptance must immediately follow its exact VSIX reverification."
  );
  assert.equal(
    interactiveRRunner?.run,
    "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix"
  );
  assert.equal(interactiveRRunner?.["continue-on-error"], true);
  assert.deepEqual(interactiveRRunner?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_R_JOURNEY: "interactive-terminal",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode,cursor",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_XVFB_EXECUTABLE: "${{ steps.prepare_xvfb.outputs.executable }}",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  const interactiveDiagnostics = job?.steps?.find(
    (step) => step?.name === "Upload active R terminal failure diagnostics"
  );
  assert.equal(
    interactiveDiagnostics?.if,
    "${{ always() && steps.packaged_editor_r_interactive.outcome == 'failure' && steps.packaged_editor_r_interactive.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(
    interactiveDiagnostics?.with?.name,
    "released-jupyter-r-interactive-diagnostics-editors-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(interactiveDiagnostics?.with?.path, "${{ steps.packaged_editor_r_interactive.outputs.evidence_path }}");
  assert.equal(job?.steps?.indexOf(interactiveDiagnostics), interactiveRRunnerIndex + 1);
  const localRFailure = job?.steps?.find((step) => step?.name === "Fail after local R acceptance diagnostics");
  assert.equal(
    localRFailure?.if,
    "${{ always() && (steps.packaged_editor_r.outcome == 'failure' || steps.packaged_editor_r_values.outcome == 'failure' || steps.packaged_editor_r_categorical.outcome == 'failure' || steps.packaged_editor_r_interactive.outcome == 'failure') }}"
  );
  assert.equal(localRFailure?.run, "exit 1");
  assert.equal(job?.steps?.indexOf(localRFailure), (job?.steps?.indexOf(interactiveDiagnostics) ?? -2) + 1);
  const linuxDiagnosticArtifactNames = job?.steps
    ?.filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/upload-artifact@"))
    .map((step) => step?.with?.name);
  assert.equal(linuxDiagnosticArtifactNames?.length, 5);
  assert.equal(new Set(linuxDiagnosticArtifactNames).size, linuxDiagnosticArtifactNames?.length);

  const macosR = workflow?.jobs?.["macos-r"];
  assert.equal(macosR?.name, "Released R Jupyter in macOS VS Code");
  assert.equal(macosR?.if, "${{ inputs.target == 'macos-r' }}");
  assert.equal(macosR?.["runs-on"], "macos-latest");
  assert.equal(macosR?.["timeout-minutes"], 45);
  assert.deepEqual(macosR?.steps?.find((step) => step?.uses === SETUP_R_ACTION)?.with, {
    "r-version": "4.5.2",
    "use-public-rspm": true
  });
  assert.equal(
    macosR?.steps?.some(
      (step) => step?.run === "npm run clean && npm run build && npm run package:prepared -- --out openwrangler.vsix"
    ),
    true
  );
  assert.equal(
    macosR?.steps?.some((step) => step?.run === "npm run verify:vsix -- openwrangler.vsix"),
    true
  );
  const macosPackagedR = macosR?.steps?.find((step) => step?.id === "packaged_editor_r");
  assert.equal(macosPackagedR?.name, "Test local R Jupyter in packaged VS Code");
  assert.equal(macosPackagedR?.run, "node scripts/run-packaged-editor-tests.mjs openwrangler.vsix");
  assert.deepEqual(macosPackagedR?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  const macosDiagnostics = macosR?.steps?.find((step) => step?.name === "Upload macOS R-Jupyter failure diagnostics");
  assert.equal(
    macosDiagnostics?.with?.name,
    "released-jupyter-r-diagnostics-vscode-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(macosDiagnostics?.with?.path, "${{ steps.packaged_editor_r.outputs.evidence_path }}");

  const windowsR = workflow?.jobs?.["windows-r"];
  assert.equal(windowsR?.name, "Released R Jupyter in Windows VS Code");
  assert.equal(windowsR?.if, "${{ inputs.target == 'windows-r' }}");
  assert.equal(windowsR?.["runs-on"], "windows-latest");
  assert.equal(windowsR?.["timeout-minutes"], 45);
  assert.deepEqual(windowsR?.steps?.find((step) => step?.uses === SETUP_R_ACTION)?.with, {
    "r-version": "4.5.2",
    "use-public-rspm": true
  });
  const windowsRscript = windowsR?.steps?.find((step) => step?.id === "rscript");
  assert.equal(windowsRscript?.shell, "Rscript {0}");
  assert.match(windowsRscript?.run ?? "", /file\.path\(R\.home\("bin"\), "Rscript\.exe"\)/u);
  assert.equal(
    windowsR?.steps?.some(
      (step) => step?.run === "npm run clean && npm run build && npm run package:prepared -- --out openwrangler.vsix"
    ),
    true
  );
  const windowsPackagedR = windowsR?.steps?.find((step) => step?.id === "packaged_editor_r");
  assert.equal(windowsPackagedR?.name, "Test local R Jupyter in packaged VS Code");
  assert.equal(windowsPackagedR?.run, "node scripts/run-packaged-editor-tests.mjs openwrangler.vsix");
  assert.deepEqual(windowsPackagedR?.env, {
    OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "0",
    OPEN_WRANGLER_TEST_RSCRIPT: "${{ steps.rscript.outputs.executable }}",
    VSCODE_TEST_VERSION: "stable"
  });
  const windowsDiagnostics = windowsR?.steps?.find(
    (step) => step?.name === "Upload Windows R-Jupyter failure diagnostics"
  );
  assert.equal(
    windowsDiagnostics?.with?.name,
    "released-jupyter-r-diagnostics-vscode-${{ runner.os }}-${{ github.run_attempt }}"
  );
  assert.equal(windowsDiagnostics?.with?.path, "${{ steps.packaged_editor_r.outputs.evidence_path }}");
});

test("standalone released-Jupyter rejects a missing or interposed core R verifier", () => {
  const source = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");

  const missingVerifier = parseYaml(source);
  const missingSteps = missingVerifier.jobs.vscode.steps;
  missingSteps.splice(
    missingSteps.findIndex((step) => step?.id === "canonical_r_jupyter"),
    1
  );
  assert.throws(
    () => assertStandaloneReleasedJupyterRTriples(missingVerifier),
    /exactly one canonical_r_jupyter verifier/u
  );

  const interposedStep = parseYaml(source);
  const interposedSteps = interposedStep.jobs.vscode.steps;
  interposedSteps.splice(
    interposedSteps.findIndex((step) => step?.id === "packaged_editor_r"),
    0,
    { run: "echo interposed" }
  );
  assert.throws(
    () => assertStandaloneReleasedJupyterRTriples(interposedStep),
    /packaged_editor_r must immediately follow canonical_r_jupyter/u
  );
});
