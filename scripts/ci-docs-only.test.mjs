import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { load } from "js-yaml";
import { proveRuntimeOmissions } from "./ci-docs-only.mjs";
import { createRContractPhases, selectRContractPhases } from "./run-r-contract-tests.mjs";

const script = resolve(import.meta.dirname, "ci-docs-only.mjs");
const allChecksRequired = {
  docsOnly: false,
  rOmittable: false,
  rRuntimeOmittable: false,
  pythonOmittable: false,
  rEditorOmittable: false,
  nativeSparkOmittable: false
};
const arrowFormulaHelper = "python/openwrangler_runtime/engines/_pandas_arrow_formula_helpers.py";
const arrowFormulaTests = ["python/tests/test_operation_edges.py", "python/tests/test_session_transactions.py"];
const pandasFilterTests = ["python/tests/test_pandas_engine.py", "python/tests/test_filter_logic.py"];
const screenshot = "docs/images/acceptance/operation-dialog-dark-1280.png";
const performanceReport = "docs/performance/2026-09-17-release-preparation/notebook-samples.json";
const mediaCompositor = "scripts/compose-readme-media.mjs";
const browserInteractions = "scripts/test-webview-accessibility.mjs";
const importPromptFile = "src/extension/files/importOptions.ts";
const hostSourceFiles = [
  "src/extension/nativeViews.ts",
  "src/extension/nativeViewsExportOptions.ts",
  "src/test/nativeViewStateCommands.unit.test.ts",
  "src/test/nativeViewExportCommands.unit.test.ts",
  importPromptFile,
  "src/test/importOptions.unit.test.ts",
  "src/test/webviewPanel.unit.test.ts"
];
const workflow = load(readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8"));
const releasedJupyter = load(
  readFileSync(resolve(import.meta.dirname, "../.github/workflows/released-jupyter.yml"), "utf8")
);

function git(cwd, ...args) {
  // Detached maintenance must not keep writing into a fixture during cleanup.
  return execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "maintenance.auto=false",
      "-c",
      "user.email=ci-test@openwrangler.invalid",
      "-c",
      "user.name=Open Wrangler CI Test",
      ...args
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024
    }
  ).trim();
}

function write(cwd, file, text = "updated\n") {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
}

function repository(context, extraFiles = []) {
  const cwd = mkdtempSync(join(tmpdir(), "openwrangler-ci-docs-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--quiet", "--initial-branch=main");
  for (const file of ["README.md", "docs/testing.md", "src/runtime.py", "package.json", ...extraFiles]) {
    write(cwd, file, "original\n");
  }
  git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "-m", "protected base");
  git(cwd, "checkout", "--quiet", "-b", "change");
  return cwd;
}

function merge(cwd, stage = true) {
  if (stage) git(cwd, "add", "--all");
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", "change");
  const head = git(cwd, "rev-parse", "HEAD");
  // Mode fixtures change the index directly without requiring host symlink privileges.
  git(cwd, "checkout", "--quiet", "--force", "main");
  const base = git(cwd, "rev-parse", "HEAD");
  git(cwd, "merge", "--quiet", "--no-ff", "--no-edit", "change");
  return {
    CI_EVENT: "pull_request",
    CI_BASE_REF: "main",
    CI_BASE_SHA: base,
    CI_HEAD_SHA: head,
    CI_MERGE_SHA: git(cwd, "rev-parse", "HEAD")
  };
}

test("proves existing Markdown edits against the exact tested merge", async (context) => {
  for (const [caseIndex, files] of [
    ["README.md", "docs/testing.md", "docs/guides/über view.md"],
    ["CHANGELOG.md"],
    ["CONTRIBUTING.md"],
    ["AGENTS.md"],
    ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md", "docs/testing.md"]
  ].entries()) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: true,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: true,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
      if (caseIndex === 0) {
        const output = join(cwd, "action-output");
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
        assert.equal(
          readFileSync(output, "utf8"),
          "docs_only=true\nr_omittable=true\nr_runtime_omittable=true\npython_omittable=true\nr_editor_omittable=false\nnative_spark_omittable=false\n"
        );
      }
    });
  }
});

test("proves documentary additions, edits and removals", async (context) => {
  for (const { added = [], removed = [], modified = [] } of [
    { removed: ["docs/testing.md"], modified: [] },
    { removed: ["CONTRIBUTING.md"], modified: [] },
    { added: ["CHANGELOG.md", "CONTRIBUTING.md", "AGENTS.md"] },
    {
      added: [
        "docs/performance/everyday-tasks/method.md",
        "docs/performance/everyday-tasks/review.md",
        "docs/performance/everyday-tasks/duckdb.json",
        "docs/performance/everyday-tasks/native-r.json",
        "docs/performance/everyday-tasks/pyspark.json"
      ]
    },
    { modified: ["docs/performance/everyday-tasks/duckdb.json"] },
    { removed: ["docs/performance/everyday-tasks/duckdb.json"] },
    {
      removed: ["docs/performance-comparison.md"],
      modified: [
        "AGENTS.md",
        "README.md",
        "docs/feature-parity.md",
        "docs/performance/data-wrangler-1.2.1/review.md",
        "docs/testing.md"
      ]
    }
  ]) {
    await context.test([...added, ...removed, ...modified].join(", "), (child) => {
      const cwd = repository(child, [...removed, ...modified]);
      for (const file of removed) rmSync(join(cwd, file));
      for (const file of [...added, ...modified])
        write(cwd, file, file.endsWith(".json") ? '{"samples":[1,2,3]}\n' : "updated\n");
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), {
        docsOnly: true,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: true,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
    });
  }
});

test("keeps all owners for documentary additions or removals mixed with otherwise omittable source", async (context) => {
  for (const { file, added = false, document = "docs/testing.md", status = "D" } of [
    { file: "python/openwrangler_runtime/engines/pandas_engine.py" },
    { file: "python/tests/added.py", added: true },
    { file: "r/tests/kernel_agent.R" },
    { file: "r/tests/added.R", added: true },
    { file: "src/test/webview.component.test.tsx" },
    { file: screenshot },
    { file: browserInteractions },
    { file: browserInteractions, document: "docs/new.md", status: "A" },
    { file: importPromptFile },
    { file: importPromptFile, document: "docs/new.md", status: "A" },
    { file: screenshot, document: performanceReport, status: "A" },
    { file: screenshot, document: performanceReport, status: "D" },
    { file: "python/tests/existing.py", document: "docs/new.md", status: "A" },
    { file: "r/tests/kernel_agent.R", document: "docs/performance/result.json", status: "A" },
    { file: "python/tests/added.py", added: true, document: "docs/performance/result.json" }
  ]) {
    await context.test(`${file}, added=${added}, ${status} ${document}`, (child) => {
      const cwd = repository(child, [...(added ? [] : [file]), ...(status === "A" ? [] : [document])]);
      if (status === "D") rmSync(join(cwd, document));
      else write(cwd, document);
      write(cwd, file);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
    });
  }
});

test("proves existing component test edits while retaining Source execution", (context) => {
  const files = [
    "src/test/appColumnProjection.component.test.tsx",
    "src/test/appShortcuts.component.test.tsx",
    "src/test/filterSummary.component.test.tsx",
    "src/test/webview.component.test.tsx",
    performanceReport
  ];
  const cwd = repository(context, files);
  for (const file of files) write(cwd, file);
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
    docsOnly: false,
    rOmittable: true,
    rRuntimeOmittable: true,
    pythonOmittable: true,
    rEditorOmittable: false,
    nativeSparkOmittable: false
  });
  const output = join(cwd, "action-output");
  execFileSync(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env, GITHUB_OUTPUT: output },
    encoding: "utf8"
  });
  assert.equal(
    readFileSync(output, "utf8"),
    "docs_only=false\nr_omittable=true\nr_runtime_omittable=true\npython_omittable=true\nr_editor_omittable=false\nnative_spark_omittable=false\n"
  );
});

test("proves the existing R test owners can omit only installed editor execution", async (context) => {
  for (const [caseIndex, files] of [
    ["r/tests/kernel_agent.R"],
    ["r/tests/frame_contract.R"],
    ["r/tests/complete_catalog_contract.R"],
    [
      "r/tests/kernel_agent.R",
      "r/tests/frame_contract.R",
      "r/tests/complete_catalog_contract.R",
      "README.md",
      "CHANGELOG.md",
      "docs/testing.md"
    ]
  ].entries()) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: false,
        rRuntimeOmittable: false,
        pythonOmittable: true,
        rEditorOmittable: true,
        nativeSparkOmittable: false
      });
      if (caseIndex === 0) {
        const output = join(cwd, "action-output");
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
        assert.equal(
          readFileSync(output, "utf8"),
          "docs_only=false\nr_omittable=false\nr_runtime_omittable=false\npython_omittable=true\nr_editor_omittable=true\nnative_spark_omittable=false\n"
        );
      }
    });
  }
});

test("mixed R test edits keep editor execution when another input changes", async (context) => {
  for (const other of [
    "r/openwrangler_runtime/kernel_agent.R",
    "r/tests/kernel_agent_support.R",
    "python/tests/test_runtime.py",
    "src/test/extensionHost/releasedRCoreEditing.ts",
    "src/test/webview.component.test.tsx",
    "fixtures/sample.csv",
    "r/dependencies/native-r-contract/ubuntu-24.04-x86_64-r-4.5.lock.json",
    "scripts/editor-acceptance.mjs",
    "scripts/release-metadata.mjs",
    "scripts/ci-docs-only.mjs",
    ".github/workflows/released-jupyter.yml",
    "package-lock.json"
  ]) {
    await context.test(other, (child) => {
      const file = "r/tests/kernel_agent.R";
      const cwd = repository(child, [file, other]);
      write(cwd, file);
      write(cwd, other);
      assert.equal(proveRuntimeOmissions({ cwd, env: merge(cwd) }).rEditorOmittable, false);
    });
  }
});

test("proves existing script and media edits while retaining Source and package execution", async (context) => {
  for (const files of [
    ["scripts/ci-docs-only.test.mjs"],
    ["scripts/ci-docs-only.test.mjs", "README.md", "docs/ci.md"],
    [
      "scripts/release-metadata.mjs",
      "scripts/daily-preview-artifact.mjs",
      "scripts/daily-preview-artifact.test.mjs",
      "scripts/prepare-stable-candidate-tag.mjs",
      "scripts/prepare-stable-candidate-tag.test.mjs",
      "scripts/release-tag-publisher.mjs",
      "scripts/push-stable-release-tag.mjs",
      "scripts/push-stable-release-tag.test.mjs",
      "scripts/publish-github-stable-release.mjs",
      "scripts/publish-github-stable-release.test.mjs",
      "scripts/verify-canonical-release-artifact.mjs",
      "scripts/verify-canonical-release-artifact.test.mjs",
      "scripts/registry-release-source.test.mjs",
      "scripts/verify-registry-release-artifact.test.mjs",
      "CHANGELOG.md",
      "docs/ci.md"
    ],
    ["scripts/release-documents.mjs"],
    ["scripts/release-readiness.mjs"],
    ["scripts/create-canonical-release-artifact.test.mjs"],
    ["scripts/registry-release-source.test.mjs"],
    ["scripts/verify-registry-release-artifact.test.mjs"],
    [
      "scripts/release-documents.mjs",
      "scripts/release-readiness.mjs",
      "scripts/create-canonical-release-artifact.test.mjs",
      "README.md",
      "docs/feature-parity.md",
      "docs/releasing.md"
    ],
    ["scripts/capture-screenshots.mjs"],
    [browserInteractions],
    [browserInteractions, "README.md", "docs/testing.md"],
    ["scripts/capture-screenshots-readiness.mjs"],
    [mediaCompositor],
    [screenshot],
    [
      "docs/images/editor-acceptance/vscode-notebook-r-code-insertion-dark.png",
      performanceReport,
      "docs/performance/2026-09-17-release-preparation/review.md"
    ],
    [
      mediaCompositor,
      screenshot,
      "docs/images/editor-acceptance/vscode-explore-dark.png",
      "docs/images/readme/gallery/by-example-setup.png",
      "README.md",
      "docs/media-gallery.md"
    ],
    [
      "scripts/capture-screenshots.mjs",
      "scripts/capture-screenshots-readiness.mjs",
      "README.md",
      "CHANGELOG.md",
      "docs/testing.md"
    ]
  ]) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: true,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
    });
  }
});

test("proves existing Python source and documentary edits only for native R", async (context) => {
  const cases = [
    ["python/openwrangler_runtime/protocol.py"],
    ["python/openwrangler_runtime/session.py"],
    ["python/tests/conftest.py"],
    ["python/tests/test_runtime.py", "scripts/ci-docs-only.test.mjs"],
    [browserInteractions, "python/openwrangler_runtime/session.py"],
    [screenshot, "python/openwrangler_runtime/engines/duckdb_engine.py"],
    [mediaCompositor, screenshot, "python/openwrangler_runtime/session.py"],
    [
      "python/openwrangler_runtime/engines/duckdb_engine.py",
      "python/tests/test_duckdb_engine.py",
      "scripts/release-metadata.mjs",
      "scripts/capture-screenshots.mjs",
      "src/test/webview.component.test.tsx",
      "README.md",
      "CHANGELOG.md",
      "docs/architecture.md",
      performanceReport
    ]
  ];
  for (const [caseIndex, files] of cases.entries()) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: false,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
      if (caseIndex === 0) {
        const output = join(cwd, "action-output");
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
        assert.equal(
          readFileSync(output, "utf8"),
          "docs_only=false\nr_omittable=true\nr_runtime_omittable=true\npython_omittable=false\nr_editor_omittable=false\nnative_spark_omittable=false\n"
        );
      }
    });
  }
});

test("omits native Spark for nonempty subsets of the existing local-engine owners", async (context) => {
  for (const [caseIndex, files] of [
    [arrowFormulaHelper],
    [arrowFormulaTests[0]],
    [arrowFormulaTests[1]],
    [arrowFormulaHelper, arrowFormulaTests[0]],
    [arrowFormulaHelper, arrowFormulaTests[1]],
    [...arrowFormulaTests, "docs/testing.md"],
    [arrowFormulaHelper, ...arrowFormulaTests, "README.md", "CHANGELOG.md", "docs/architecture.md"],
    ["python/openwrangler_runtime/engines/pandas_engine.py"],
    ["python/openwrangler_runtime/engines/duckdb_engine.py"],
    ["python/tests/test_duckdb_engine.py"],
    ["python/tests/test_split_text_columns.py"],
    ["python/tests/test_operations.py"],
    [pandasFilterTests[0]],
    [pandasFilterTests[1]],
    [
      "python/openwrangler_runtime/engines/pandas_engine.py",
      "python/openwrangler_runtime/engines/duckdb_engine.py",
      "python/tests/test_duckdb_engine.py",
      "python/tests/test_split_text_columns.py",
      ...pandasFilterTests,
      "CHANGELOG.md",
      "docs/architecture.md",
      "docs/feature-parity.md"
    ]
  ].entries()) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: false,
        rEditorOmittable: false,
        nativeSparkOmittable: true
      });
      if (caseIndex === 0) {
        const output = join(cwd, "action-output");
        execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
        assert.equal(
          readFileSync(output, "utf8"),
          "docs_only=false\nr_omittable=true\nr_runtime_omittable=true\npython_omittable=false\nr_editor_omittable=false\nnative_spark_omittable=true\n"
        );
      }
    });
  }
});

test("keeps native Spark for other inputs alongside the eligible local-engine owners", async (context) => {
  const cases = [
    "python/openwrangler_runtime/engines/polars_engine.py",
    "python/openwrangler_runtime/engines/base.py",
    "python/openwrangler_runtime/session.py",
    "python/openwrangler_runtime/operations.py",
    "python/openwrangler_runtime/protocol.py",
    "python/tests/test_pyspark_engine.py",
    "python/tests/conftest.py",
    "python/tests/pyspark_connect_test_support.py",
    "python/pyproject.toml",
    "package-lock.json",
    ".github/workflows/ci.yml",
    "scripts/ci-docs-only.mjs",
    "scripts/ci-docs-only.test.mjs"
  ].map((file) => [
    arrowFormulaHelper,
    ...arrowFormulaTests,
    ...pandasFilterTests,
    "python/tests/test_operations.py",
    file
  ]);
  for (const files of cases) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, [arrowFormulaHelper, ...files]);
      for (const file of files) write(cwd, file);
      assert.equal(proveRuntimeOmissions({ cwd, env: merge(cwd) }).nativeSparkOmittable, false);
    });
  }
});

test("proves added regular Python source only for native R", async (context) => {
  const cases = [
    { added: ["python/openwrangler_runtime/helper.py"], modified: [] },
    { added: ["python/tests/test_helper.py"], modified: [] },
    { added: ["python/openwrangler_runtime/nested/__init__.py"], modified: [] },
    { added: [arrowFormulaHelper], modified: arrowFormulaTests },
    { added: [arrowFormulaTests[0]], modified: [arrowFormulaHelper] },
    { added: [pandasFilterTests[0]], modified: [arrowFormulaHelper] },
    { added: [pandasFilterTests[1]], modified: [arrowFormulaHelper] },
    { added: ["python/tests/new_formula.py"], modified: [arrowFormulaHelper] },
    {
      added: ["python/openwrangler_runtime/helper.py", "python/tests/test_helper.py"],
      modified: ["python/openwrangler_runtime/session.py", "README.md", "CHANGELOG.md", "docs/testing.md"]
    }
  ];
  for (const { added, modified } of cases) {
    await context.test(added.join(", "), (child) => {
      const cwd = repository(child, modified);
      for (const file of [...added, ...modified]) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: false,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
    });
  }
});

test("proves Python omissions with selective native R source checks", async (context) => {
  const cases = [
    { added: [], modified: [screenshot, performanceReport, "r/openwrangler_runtime/frame_contract.R"], checkCli: true },
    { added: [], modified: [mediaCompositor, screenshot, "r/tests/kernel_agent.R"] },
    { added: [], modified: [mediaCompositor, screenshot, "src/test/extensionHost/index.ts"] },
    {
      added: [],
      modified: [
        "src/webviews/grid/DataGrid.tsx",
        "src/test/dataGridClipboard.component.test.tsx",
        "src/test/dataGridSelection.component.test.tsx",
        "src/test/webview.component.test.tsx",
        "docs/accessibility.md",
        "CHANGELOG.md"
      ],
      runtimeOmittable: true
    },
    {
      added: [],
      modified: [
        screenshot,
        "docs/images/readme/gallery/by-example-setup.png",
        "src/webviews/App.tsx",
        "src/webviews/grid/GridColumnHeader.tsx",
        "src/test/appFilterHistory.component.test.tsx",
        "src/test/webview.component.test.tsx",
        "scripts/capture-screenshots.mjs",
        "docs/testing.md",
        "CHANGELOG.md"
      ]
    },
    { added: [], modified: ["r/openwrangler_runtime/frame_contract.R", "r/tests/complete_catalog_contract.R"] },
    { added: [], modified: [browserInteractions, "r/openwrangler_runtime/frame_contract.R"] },
    { added: [], modified: [browserInteractions, "src/webviews/grid/DataGrid.tsx"] },
    { added: ["r/openwrangler_runtime/helper.R"], modified: [] },
    { added: ["r/tests/new_contract.R"], modified: [] },
    { added: ["r/tests/complete_catalog_contract.R"], modified: [] },
    { added: ["r/tests/new_contract.R"], modified: ["CHANGELOG.md"] },
    { added: [], modified: ["src/test/extensionHost/releasedRCoreEditing.ts"] },
    { added: [], modified: ["src/test/extensionHost/releasedRRowReduction.ts"] },
    { added: [], modified: ["src/test/extensionHost/index.ts"] },
    { added: [], modified: ["src/test/extensionHost/releasedROperationPicker.ts"] },
    { added: [], modified: ["scripts/editor-acceptance.mjs"] },
    { added: [], modified: ["scripts/editor-acceptance-artifact.test.mjs"] },
    { added: [], modified: ["src/webviews/App.tsx"], runtimeOmittable: true, checkCli: true },
    { added: [], modified: ["src/webviews/grid/rowScrollModel.ts"], runtimeOmittable: true },
    { added: [], modified: ["src/webviews/grid/DataGrid.tsx"], runtimeOmittable: true },
    { added: [], modified: ["src/webviews/styles/grid.css"], runtimeOmittable: true },
    ...hostSourceFiles.map((file) => ({ added: [], modified: [file], runtimeOmittable: true })),
    {
      added: [],
      modified: [...hostSourceFiles, "docs/architecture.md", "docs/testing.md", "CHANGELOG.md"],
      runtimeOmittable: true
    },
    { added: [], modified: [hostSourceFiles[0], "r/openwrangler_runtime/kernel_agent.R"] },
    { added: [], modified: [importPromptFile, "r/openwrangler_runtime/kernel_agent.R"] },
    {
      added: [],
      modified: [importPromptFile, "python/openwrangler_runtime/session.py"],
      pythonOmittable: false
    },
    {
      added: [],
      modified: [hostSourceFiles[0], "python/openwrangler_runtime/session.py"],
      pythonOmittable: false
    },
    ...[
      "r/openwrangler_runtime/frame_contract.R",
      "r/tests/kernel_agent.R",
      "src/test/progressiveProfilingLifecycle.unit.test.tsx",
      "src/test/extensionHost/releasedRCoreEditing.ts",
      "scripts/editor-acceptance.mjs",
      "scripts/capture-screenshots.mjs"
    ].map((other) => ({ added: [], modified: ["src/webviews/grid/DataGrid.tsx", other] })),
    {
      added: [],
      modified: ["src/webviews/grid/DataGrid.tsx", "python/openwrangler_runtime/session.py"],
      pythonOmittable: false
    },
    { added: [], modified: ["src/test/progressiveProfilingLifecycle.unit.test.tsx"] },
    {
      added: [],
      modified: [
        "src/webviews/progressiveProfilingLifecycle.ts",
        "src/test/progressiveProfilingLifecycle.unit.test.tsx",
        "src/test/appProgressiveProfiling.component.test.tsx",
        "docs/architecture.md"
      ]
    },
    {
      added: ["r/tests/new_contract.R"],
      modified: [
        "src/test/extensionHost/releasedRCoreEditing.ts",
        "src/test/extensionHost/releasedRRowReduction.ts",
        "src/test/webview.component.test.tsx",
        "r/openwrangler_runtime/kernel_agent.R",
        "scripts/release-metadata.mjs",
        "scripts/capture-screenshots-readiness.mjs",
        "README.md",
        "CHANGELOG.md",
        "docs/testing.md"
      ]
    },
    {
      added: ["r/openwrangler_runtime/nested/helper.R", "r/tests/new_contract.R"],
      modified: ["r/openwrangler_runtime/kernel_agent.R", "README.md", "CHANGELOG.md", "docs/testing.md"]
    }
  ];
  for (const { added, modified, runtimeOmittable = false, pythonOmittable = true, checkCli = false } of cases) {
    await context.test([...added, ...modified].join(", "), (child) => {
      const cwd = repository(child, modified);
      for (const file of [...added, ...modified]) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
        docsOnly: false,
        rOmittable: false,
        rRuntimeOmittable: runtimeOmittable,
        pythonOmittable,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
      if (checkCli) {
        const output = join(cwd, "action-output");
        const message = execFileSync(process.execPath, [script], {
          cwd,
          env: { ...process.env, ...env, GITHUB_OUTPUT: output },
          encoding: "utf8"
        });
        if (runtimeOmittable) {
          assert.match(
            message,
            /^Verified selected host and renderer edits permit omission of Python, native R source and Windows filesystem and process checks; platform artifact, package and installed-editor checks remain required\./u
          );
        } else if (pythonOmittable) {
          assert.match(message, /Python worker; R, editor and Windows checks remain required\./u);
        }
        assert.equal(
          readFileSync(output, "utf8"),
          `docs_only=false\nr_omittable=false\nr_runtime_omittable=${runtimeOmittable}\npython_omittable=${pythonOmittable}\nr_editor_omittable=false\nnative_spark_omittable=false\n`
        );
      }
    });
  }
});

test("keeps both runtimes required for R and CHANGELOG changes with Python source or shared inputs", async (context) => {
  for (const added of [false, true]) {
    for (const other of [
      "python/tests/test_runtime.py",
      "src/shared/protocol.ts",
      "src/shared/installedPerformanceFixtureManifest.cjs"
    ]) {
      await context.test(`${other}, added=${added}`, (child) => {
        const rSource = "r/tests/contract.R";
        const journey = "src/test/extensionHost/releasedRCoreEditing.ts";
        const webview = "src/webviews/progressiveProfilingLifecycle.ts";
        const cwd = repository(
          child,
          added ? ["CHANGELOG.md", journey, webview] : [rSource, other, "CHANGELOG.md", journey, webview]
        );
        write(cwd, rSource);
        write(cwd, journey);
        write(cwd, webview);
        write(cwd, other);
        write(cwd, "CHANGELOG.md");
        assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
      });
    }
  }
});

test("requires full owners for deleted or renamed source, including alongside additions", async (context) => {
  for (const file of [
    screenshot,
    mediaCompositor,
    browserInteractions,
    hostSourceFiles[0],
    importPromptFile,
    "src/webviews/progressiveProfilingLifecycle.ts",
    "src/test/progressiveProfilingLifecycle.unit.test.tsx",
    arrowFormulaHelper,
    "python/openwrangler_runtime/session.py",
    "r/openwrangler_runtime/kernel_agent.R",
    "r/tests/kernel_agent.R",
    "src/test/extensionHost/releasedRCoreEditing.ts",
    "scripts/editor-acceptance.mjs",
    "scripts/release-metadata.mjs",
    "src/test/webview.component.test.tsx"
  ]) {
    for (const change of ["add and delete", "delete", "rename", "rename into runtime"]) {
      await context.test(`${file}: ${change}`, (child) => {
        const cwd = repository(child, [file]);
        const destination = file.replace(/\.(py|R|tsx?|mjs|png)$/u, "-new.$1");
        if (change === "add and delete") {
          write(cwd, destination);
          rmSync(join(cwd, file));
        }
        if (change === "delete") rmSync(join(cwd, file));
        if (change === "rename") renameSync(join(cwd, file), join(cwd, destination));
        if (change === "rename into runtime") renameSync(join(cwd, "src/runtime.py"), join(cwd, destination));
        const env = merge(cwd);
        assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
      });
    }
  }
});

test("requires full owners for source mode changes and existing executable or symlink entries", async (context) => {
  for (const file of [
    screenshot,
    mediaCompositor,
    browserInteractions,
    hostSourceFiles[0],
    importPromptFile,
    "src/webviews/styles/grid.css",
    "src/test/progressiveProfilingLifecycle.unit.test.tsx",
    arrowFormulaHelper,
    "python/tests/helper.py",
    "r/tests/kernel_agent.R",
    "src/test/extensionHost/releasedRCoreEditing.ts",
    "scripts/editor-acceptance-artifact.test.mjs",
    "scripts/release-metadata.mjs",
    "src/test/webview.component.test.tsx"
  ]) {
    for (const mode of ["100755", "120000"]) {
      for (const existing of [false, true]) {
        await context.test(`${file}: ${mode}, existing=${existing}`, (child) => {
          const cwd = repository(child, [file]);
          const original = git(cwd, "rev-parse", `HEAD:${file}`);
          git(cwd, "update-index", "--cacheinfo", `${mode},${original},${file}`);
          if (existing) {
            git(cwd, "commit", "--quiet", "-m", "existing special entry");
            git(cwd, "branch", "--force", "main", "HEAD");
            // Different bytes are needed even when the entry retains its special mode.
            write(cwd, "changed-blob", "changed target\n");
            const changed = git(cwd, "hash-object", "-w", "changed-blob");
            assert.notEqual(changed, original);
            git(cwd, "update-index", "--cacheinfo", `${mode},${changed},${file}`);
          }
          const env = merge(cwd, false);
          assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
        });
      }
    }
  }
});

test("requires full owners for added executable or symlink runtime source", async (context) => {
  for (const file of [
    "python/tests/added.py",
    "r/tests/kernel_agent.R",
    "src/test/extensionHost/releasedRCoreEditing.ts",
    "scripts/editor-acceptance.mjs"
  ]) {
    for (const mode of ["100755", "120000"]) {
      await context.test(`${file}: ${mode}`, (child) => {
        const cwd = repository(child);
        const blob = git(cwd, "rev-parse", "HEAD:README.md");
        git(cwd, "update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`);
        assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd, false) }), allChecksRequired);
      });
    }
  }
});

test("requires full owners for additions outside the documentary and runtime source scopes", async (context) => {
  for (const file of [
    screenshot,
    mediaCompositor,
    browserInteractions,
    ...hostSourceFiles,
    "src/webviews/progressiveProfilingLifecycle.ts",
    "src/test/progressiveProfilingLifecycle.unit.test.tsx",
    "docs/result.json",
    "docs/performance-extra/result.json",
    "docs/performance/probe.py",
    "src/new.py",
    "scripts/new.py",
    "python/pyproject.toml",
    "python/tests-extra/new.py",
    "python/tests/new.PY",
    "scripts/new.R",
    "r/tests-extra/new.R",
    "r/tests/new.r",
    "r/dependencies/new.R",
    "src/test/extensionHost/releasedRCoreEditing.ts",
    "scripts/editor-acceptance-artifact.test.mjs",
    "scripts/release-metadata.mjs",
    "scripts/ci-docs-only.test.mjs",
    "scripts/capture-screenshots.mjs",
    "src/test/webview.component.test.tsx"
  ]) {
    await context.test(file, (child) => {
      const cwd = repository(child);
      write(cwd, file);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
    });
  }
});

test("requires full owners for control characters in source paths", async (context) => {
  for (const file of [
    "docs/images/unusual\nname.png",
    "src/webviews/unusual\nname.ts",
    "python/tests/unusual\nname.py",
    "r/tests/unusual\nname.R",
    "src/test/extensionHost/unusual\nname.ts",
    "src/test/unusual\nname.component.test.tsx"
  ]) {
    for (const added of [false, true]) {
      await context.test(`${file}, added=${added}`, (child) => {
        const cwd = repository(child, added ? [] : [file]);
        write(cwd, file);
        assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
      });
    }
  }
});

test("requires full owners for an added runtime source path with invalid UTF-8", async (context) => {
  for (const [directory, extension] of [
    ["python/tests/", ".py"],
    ["r/tests/", ".R"]
  ]) {
    await context.test(directory, (child) => {
      const cwd = repository(child);
      const base = git(cwd, "rev-parse", "main");
      const blob = git(cwd, "rev-parse", "HEAD:README.md");
      const path = Buffer.concat([Buffer.from(directory), Buffer.from([0xff]), Buffer.from(extension)]);
      execFileSync("git", ["update-index", "--add", "-z", "--index-info"], {
        cwd,
        input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), path, Buffer.from("\0")]),
        stdio: ["pipe", "ignore", "pipe"]
      });
      git(cwd, "commit", "--quiet", "-m", "add non-UTF-8 path");
      const head = git(cwd, "rev-parse", "HEAD");
      // Build the real merge without checking out a filename that Windows cannot represent.
      const merged = git(cwd, "commit-tree", git(cwd, "write-tree"), "-p", base, "-p", head, "-m", "merge");
      git(cwd, "update-ref", "HEAD", merged);
      assert.deepEqual(
        proveRuntimeOmissions({
          cwd,
          env: {
            CI_EVENT: "pull_request",
            CI_BASE_REF: "main",
            CI_BASE_SHA: base,
            CI_HEAD_SHA: head,
            CI_MERGE_SHA: merged
          }
        }),
        allChecksRequired
      );
    });
  }
});

test("requires full owners for runtime, metadata, fixture, workflow and script changes", async (context) => {
  for (const file of [
    "src/runtime.py",
    "package.json",
    "fixtures/example.csv",
    ".github/workflows/ci.yml",
    "scripts/ci-docs-only.mjs",
    "docs/example.py",
    "docs/result.json",
    "docs/performance-extra/result.json",
    "docs/performance/probe.py",
    "docs/image.svg",
    "docs/images/image.svg",
    "docs/images/image.PNG",
    "docs/images/image.png.bak",
    "docs/images-extra/image.png",
    "media/icon.png",
    "AGENTS.md.bak",
    "CONTRIBUTING.md.bak",
    "src/shared/protocol.ts",
    "src/webviews-extra/App.tsx",
    "src/webviews.ts",
    "src/test/progressiveProfilingLifecycle.unit.test.ts",
    "src/test/nested/progressiveProfilingLifecycle.unit.test.tsx",
    "src/test/popoverTestSetup.ts",
    "src/test/dependencyInstaller.unit.test.ts",
    "src/test/rPrivateArtifactBoundary.unit.test.ts",
    "src/test/rKernelTransport.cross.test.ts",
    "src/test/extensionHost/nested.component.test.tsx",
    "src/test/webview.component.test.ts",
    "src/test/component.test.tsx",
    "tsconfig.extension-test.json",
    "src/extension/r/rKernelBridge.ts",
    "src/extension/nativeViewsDataExport.ts",
    "src/extension/files/importDetection.ts",
    "src/extension/files/fileOpen.ts",
    "src/extension/files/importOptions.ts.bak",
    "src/extension/webviewPanel.ts",
    "src/test/nested/importOptions.unit.test.ts",
    "src/extension/nativeViews.ts.bak",
    "src/extension/nested/nativeViews.ts",
    "src/test/nativeViews.testFixtures.ts",
    "src/test/nested/nativeViewStateCommands.unit.test.ts",
    "src/shared/installedPerformanceFixtureManifest.cjs",
    "src/test/extensionHost/nested/helper.ts",
    "src/test/extensionHost/releasedRCoreEditing.ts.bak",
    "src/test/extensionHost/releasedRCoreEditing.tsx",
    "src/test/extensionHost-extra/releasedRRowReduction.ts",
    "fixtures/view-literal-contract.json",
    "scripts/r-contract-signal.py",
    "scripts/ci-docs-only.test.mjs.bak",
    "scripts/editor-acceptance.mjs.bak",
    "scripts/editor-acceptance-extra.mjs",
    "scripts/release-metadata.test.mjs",
    "scripts/registry-release-source.mjs",
    "scripts/verify-registry-release-artifact.mjs",
    "scripts/release-metadata-extra.mjs",
    "scripts/capture-screenshots-extra.mjs",
    "scripts/capture-screenshots-readiness.mjs.bak",
    "scripts/compose-readme-media.mjs.bak",
    "scripts/public-media-contract.mjs",
    "scripts/webview-browser.mjs",
    "scripts/test-webview-accessibility.mjs.bak",
    "scripts/nested/test-webview-accessibility.mjs",
    "package-lock.json",
    "python/pyproject.toml",
    "python/README.md",
    "python/openwrangler_runtime.py",
    "python/tests-extra/helper.py",
    "python/tests/helper.PY",
    "python/openwrangler_runtime/helper.py.bak",
    "vite.config.mts",
    ".npmrc",
    "r/openwrangler_runtime.R",
    "r/tests-extra/helper.R",
    "r/openwrangler_runtime/helper.r",
    "r/tests/helper.py",
    "r/openwrangler_runtime/helper.R.bak",
    "r/dependencies/native-r-contract/lock.json"
  ]) {
    await context.test(file, (child) => {
      const component = "src/test/webview.component.test.tsx";
      const releasePolicy = "scripts/release-metadata.mjs";
      const proofTest = "scripts/ci-docs-only.test.mjs";
      const webview = "src/webviews/grid/DataGrid.tsx";
      const cwd = repository(child, [
        file,
        "CHANGELOG.md",
        "CONTRIBUTING.md",
        component,
        releasePolicy,
        proofTest,
        browserInteractions,
        webview,
        screenshot,
        performanceReport,
        ...hostSourceFiles
      ]);
      for (const hostSource of hostSourceFiles) write(cwd, hostSource);
      write(cwd, component);
      write(cwd, releasePolicy);
      write(cwd, proofTest);
      write(cwd, browserInteractions);
      write(cwd, webview);
      write(cwd, screenshot);
      write(cwd, performanceReport);
      write(cwd, "README.md");
      write(cwd, "CHANGELOG.md");
      write(cwd, "CONTRIBUTING.md");
      write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
    });
  }
});

test("proves literal moves between allowed documentary paths", async (context) => {
  for (const [source, destination] of [
    ["docs/testing.md", "docs/renamed.md"],
    ["CONTRIBUTING.md", "docs/contributing.md"],
    ["AGENTS.md", "docs/agents.md"],
    ["docs/performance/result.json", "docs/performance/archived/result.json"]
  ]) {
    await context.test(`${source} -> ${destination}`, (child) => {
      const cwd = repository(child, [source]);
      mkdirSync(dirname(join(cwd, destination)), { recursive: true });
      renameSync(join(cwd, source), join(cwd, destination));
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), {
        docsOnly: true,
        rOmittable: true,
        rRuntimeOmittable: true,
        pythonOmittable: true,
        rEditorOmittable: false,
        nativeSparkOmittable: false
      });
    });
  }
});

test("does not hide source deletions or moves behind documentary destinations", async (context) => {
  for (const destination of [undefined, "docs/runtime.md", "docs/performance/runtime.json"]) {
    await context.test(destination ?? "delete runtime", (child) => {
      const cwd = repository(child);
      if (destination === undefined) rmSync(join(cwd, "src/runtime.py"));
      else {
        mkdirSync(dirname(join(cwd, destination)), { recursive: true });
        renameSync(join(cwd, "src/runtime.py"), join(cwd, destination));
      }
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
    });
  }
});

test("requires full owners for executable or symlink documentary entries", async (context) => {
  for (const file of [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "AGENTS.md",
    "docs/testing.md",
    "docs/performance/result.json"
  ]) {
    for (const mode of ["100755", "120000"]) {
      await context.test(`${file}: ${mode}`, (child) => {
        const cwd = repository(child, [file]);
        const blob = git(cwd, "rev-parse", `HEAD:${file}`);
        git(cwd, "update-index", "--cacheinfo", `${mode},${blob},${file}`);
        const env = merge(cwd, false);
        assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
      });
    }
  }
  for (const [file, status, mode] of [
    ["docs/testing.md", "D", "100755"],
    ["docs/testing.md", "D", "120000"],
    ["docs/new.md", "A", "100755"],
    ["docs/performance/result.json", "A", "120000"],
    ["docs/performance/result.json", "D", "100755"]
  ]) {
    await context.test(`${status} ${file}: ${mode}`, (child) => {
      const cwd = repository(child);
      const blob = git(cwd, "rev-parse", "HEAD:README.md");
      git(cwd, "update-index", "--add", "--cacheinfo", `${mode},${blob},${file}`);
      if (status === "D") {
        git(cwd, "commit", "--quiet", "-m", "existing special entry");
        git(cwd, "branch", "--force", "main", "HEAD");
        git(cwd, "rm", "--cached", file);
      }
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd, false) }), allChecksRequired);
    });
  }
});

test("handles NUL-delimited paths without treating newline paths as documentation", async (context) => {
  for (const file of ["docs/unusual\nname.md", "docs/performance/unusual\nname.json"]) {
    await context.test(file, (child) => {
      const cwd = repository(child, [file]);
      write(cwd, file);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), allChecksRequired);
    });
  }
});

test("examines changes beyond a 300-file API or workflow filter limit", (context) => {
  const files = Array.from({ length: 310 }, (_, index) => `docs/page-${index}.md`);
  const cwd = repository(context, files);
  for (const file of files) write(cwd, file);
  write(cwd, "src/runtime.py");
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
});

test("falls back to full owners when the bounded Git output is exceeded", (context) => {
  const files = Array.from({ length: 1500 }, (_, index) => `docs/${"a".repeat(100)}-${index}.md`);
  const cwd = repository(context, files);
  for (const file of files) write(cwd, file);
  const env = merge(cwd);
  assert.ok(git(cwd, "diff", "--raw", "--no-abbrev", "-z", env.CI_BASE_SHA, env.CI_MERGE_SHA).length > 256 * 1024);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
});

test("requires exact event identities, protected base and two merge parents", (context) => {
  const cwd = repository(context, [arrowFormulaHelper]);
  write(cwd, arrowFormulaHelper);
  write(cwd, "README.md");
  const env = merge(cwd);
  assert.equal(proveRuntimeOmissions({ cwd, env }).nativeSparkOmittable, true);
  for (const change of [
    { CI_EVENT: "push" },
    { CI_EVENT: "merge_group" },
    { CI_BASE_REF: "release" },
    { CI_BASE_SHA: undefined },
    { CI_HEAD_SHA: "invalid" },
    { CI_MERGE_SHA: "a".repeat(40) },
    { CI_BASE_SHA: env.CI_HEAD_SHA, CI_HEAD_SHA: env.CI_BASE_SHA }
  ]) {
    assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, ...change } }), allChecksRequired);
  }
  git(cwd, "checkout", "--quiet", env.CI_HEAD_SHA);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, CI_MERGE_SHA: env.CI_HEAD_SHA } }), allChecksRequired);
});

test("uses the protected base of the tested merge and rejects stale base identities", (context) => {
  const cwd = repository(context);
  const earlierBase = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "--quiet", "main");
  write(cwd, "src/runtime.py");
  git(cwd, "commit", "--quiet", "-am", "base advances");
  git(cwd, "checkout", "--quiet", "change");
  write(cwd, "README.md");
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), {
    docsOnly: true,
    rOmittable: true,
    rRuntimeOmittable: true,
    pythonOmittable: true,
    rEditorOmittable: false,
    nativeSparkOmittable: false
  });
  assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, CI_BASE_SHA: earlierBase } }), allChecksRequired);
});

test("sufficient merge history permits omissions while missing parents require full checks", (context) => {
  const cwd = repository(context, [arrowFormulaHelper]);
  write(cwd, arrowFormulaHelper);
  write(cwd, "README.md");
  const env = merge(cwd);
  for (const depth of [1, 2, 3]) {
    const clone = mkdtempSync(join(tmpdir(), "openwrangler-ci-clone-"));
    context.after(() => rmSync(clone, { recursive: true, force: true }));
    git(cwd, "clone", "--quiet", "--depth", String(depth), pathToFileURL(cwd).href, clone);
    assert.deepEqual(proveRuntimeOmissions({ cwd: clone, env }), {
      docsOnly: false,
      rOmittable: depth >= 2,
      rRuntimeOmittable: depth >= 2,
      pythonOmittable: false,
      rEditorOmittable: false,
      nativeSparkOmittable: depth >= 2
    });
  }
});

test("empty diffs and Git failures select full checks", (context) => {
  const cwd = repository(context);
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
  rmSync(join(cwd, ".git"), { recursive: true });
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), allChecksRequired);
  const output = join(cwd, "action-output");
  execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
  assert.equal(
    readFileSync(output, "utf8"),
    "docs_only=false\nr_omittable=false\nr_runtime_omittable=false\npython_omittable=false\nr_editor_omittable=false\nnative_spark_omittable=false\n"
  );
});

test("Source reuses the exact proof locally without changing job scheduling", () => {
  const source = workflow.jobs.javascript;
  const guard = source.steps.find((step) => step.name === "TypeScript checks");
  assert.equal(source.needs, undefined);
  assert.equal(source.if, undefined);
  const checkoutIndex = source.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  const node24Index = source.steps.findIndex(
    (step) => step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version-file"] === ".node-version"
  );
  const proofIndex = source.steps.findIndex((step) => step.id === "proof");
  const guardIndex = source.steps.indexOf(guard);
  assert.ok(checkoutIndex >= 0 && node24Index > checkoutIndex && proofIndex > node24Index && guardIndex > proofIndex);
  for (const proof of [
    source.steps[proofIndex],
    workflow.jobs["docs-proof"].steps.find((step) => step.id === "proof"),
    workflow.jobs["package-editor"].steps.find((step) => step.id === "proof")
  ]) {
    assert.equal(proof.run, "node scripts/ci-docs-only.mjs");
    assert.deepEqual(proof.env, {
      CI_EVENT: "${{ github.event_name }}",
      CI_BASE_REF: "${{ github.event.pull_request.base.ref }}",
      CI_BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      CI_HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      CI_MERGE_SHA: "${{ github.sha }}"
    });
  }
  assert.equal(guard.shell, "bash");
  assert.deepEqual(guard.env, {
    DOCS_ONLY: "${{ steps.proof.outputs.docs_only }}"
  });
  for (const step of source.steps) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined, "a failed local proof must stop later Source steps");
  }
  for (const command of ["npm run lint", "npm run typecheck"]) {
    assert.deepEqual(
      source.steps.filter((step) => step.run?.includes(command)),
      [guard]
    );
  }
  assert.ok(source.steps.findIndex((step) => step.run === "npm run format:check") > proofIndex);
  const node22Index = source.steps.findIndex(
    (step) => step.uses?.startsWith("actions/setup-node@") && step.with?.["node-version"] === "22.17.0"
  );
  const buildIndex = source.steps.findIndex((step) => step.run === "npm run build");
  assert.ok(node22Index > guardIndex && buildIndex > node22Index);
});

test("Source omits lint, types and Vitest only for a successful exact documentation proof", async (context) => {
  const guard = workflow.jobs.javascript.steps.find((step) => step.name === "TypeScript checks");
  const lint = "npm run lint";
  const types = "npm run typecheck";
  const vitest = "npx --no-install vitest run";
  for (const [docsOnly, lintStatus, typeStatus, npxStatus, expectedStatus, invoked] of [
    ["true", 37, 38, 39, 0, []],
    ["false", 0, 0, 0, 0, [lint, types, vitest]],
    ["false", 37, 0, 0, 37, [lint]],
    ["false", 0, 38, 0, 38, [lint, types]],
    ["false", 0, 0, 39, 39, [lint, types, vitest]],
    [undefined, 0, 0, 0, 1, []],
    ["", 0, 0, 0, 1, []],
    ["TRUE", 0, 0, 0, 1, []],
    ["true\nfalse", 0, 0, 0, 1, []]
  ]) {
    await context.test(`${JSON.stringify(docsOnly)}/status=${lintStatus},${typeStatus},${npxStatus}`, (child) => {
      const temp = mkdtempSync(join(tmpdir(), "openwrangler-ci-typescript-"));
      child.after(() => rmSync(temp, { recursive: true, force: true }));
      const marker = join(temp, "invocation");
      const summary = join(temp, "summary");
      writeFileSync(marker, "");
      writeFileSync(summary, "");
      writeFileSync(
        join(temp, "npm"),
        '#!/bin/sh\nprintf \'%s\\n\' "npm $*" >> "$COMMAND_MARKER"\ncase "$1:$2" in\n  run:lint) exit "$LINT_STATUS" ;;\n  run:typecheck) exit "$TYPE_STATUS" ;;\n  *) exit 97 ;;\nesac\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(temp, "npx"),
        '#!/bin/sh\nprintf \'%s\\n\' "npx $*" >> "$COMMAND_MARKER"\nexit "$NPX_STATUS"\n',
        {
          mode: 0o755
        }
      );
      const env = {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        COMMAND_MARKER: marker,
        LINT_STATUS: String(lintStatus),
        TYPE_STATUS: String(typeStatus),
        NPX_STATUS: String(npxStatus),
        R_OMITTABLE: "true",
        PYTHON_OMITTABLE: "true",
        GITHUB_STEP_SUMMARY: summary
      };
      if (docsOnly === undefined) delete env.DOCS_ONLY;
      else env.DOCS_ONLY = docsOnly;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 10_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus);
      assert.deepEqual(readFileSync(marker, "utf8").split("\n").filter(Boolean), invoked);
      if (docsOnly === "true") {
        assert.match(
          readFileSync(summary, "utf8"),
          /ESLint, Node 24 type checking and Vitest omitted:.*No fresh execution of these checks is claimed/u
        );
      } else {
        assert.equal(readFileSync(summary, "utf8"), "");
      }
    });
  }
});

test("package smoke keeps its prerequisites and scheduling before the local documentation decision", () => {
  const job = workflow.jobs["package-editor"];
  assert.equal(job.needs, undefined);
  assert.equal(job.if, undefined);
  const checkoutIndex = job.steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
  const nodeIndex = job.steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
  const proofIndex = job.steps.findIndex((step) => step.id === "proof");
  const guardIndex = job.steps.findIndex((step) => step.id === "packaged_editor");
  assert.equal(job.steps[checkoutIndex].with["fetch-depth"], 0);
  assert.equal(job.steps[nodeIndex].with["node-version-file"], ".node-version");
  assert.ok(checkoutIndex >= 0 && nodeIndex > checkoutIndex && proofIndex > nodeIndex);
  let previous = proofIndex;
  for (const run of [
    "npm ci --ignore-scripts",
    "python -m pip install -e python",
    "npm run clean",
    "npm run build",
    "npm run package:prepared -- --out openwrangler.vsix",
    "npm run verify:vsix -- openwrangler.vsix"
  ]) {
    const index = job.steps.findIndex((step) => step.run === run);
    assert.ok(index > previous && index < guardIndex, `${run} must remain before the launch decision`);
    previous = index;
  }
  assert.equal(
    job.steps.some((step) => step.run === "npm run build:test-extension"),
    false,
    "harness compilation must be part of the guarded editor execution"
  );
  for (const step of job.steps.slice(0, guardIndex + 1)) {
    assert.equal(step.if, undefined, "proof or prerequisite failure must stop the normal job steps");
    assert.equal(step["continue-on-error"], undefined);
  }
  const guard = job.steps[guardIndex];
  assert.equal(guard.shell, "bash");
  assert.deepEqual(guard.env, {
    DOCS_ONLY: "${{ steps.proof.outputs.docs_only }}",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke",
    OPEN_WRANGLER_TEST_SELECTOR: "daily-core"
  });
});

test("package smoke omits documentation compilation and launches while preserving failures", async (context) => {
  const guard = workflow.jobs["package-editor"].steps.find((step) => step.id === "packaged_editor");
  for (const [docsOnly, compileStatus, minimumStatus, stableStatus, expectedStatus, versions] of [
    ["true", 53, 0, 0, 0, []],
    ["false", 0, 0, 0, 0, ["1.106.0", "stable"]],
    ["false", 53, 0, 0, 53, []],
    ["false", 0, 37, 0, 37, ["1.106.0"]],
    ["false", 0, 0, 41, 41, ["1.106.0", "stable"]],
    [undefined, 0, 0, 0, 1, []],
    ["", 0, 0, 0, 1, []],
    ["TRUE", 0, 0, 0, 1, []],
    ["true\nfalse", 0, 0, 0, 1, []]
  ]) {
    const label = `${JSON.stringify(docsOnly)}/compile=${compileStatus}/editors=${minimumStatus},${stableStatus}`;
    await context.test(label, (child) => {
      const temp = mkdtempSync(join(tmpdir(), "openwrangler-ci-package-"));
      child.after(() => rmSync(temp, { recursive: true, force: true }));
      const marker = join(temp, "invocation");
      const summary = join(temp, "summary");
      writeFileSync(marker, "");
      writeFileSync(summary, "");
      writeFileSync(
        join(temp, "npm"),
        '#!/bin/sh\nprintf \'%s\\n\' npm "$@" >> "$NODE_MARKER"\nexit "$COMPILE_STATUS"\n',
        { mode: 0o755 }
      );
      writeFileSync(
        join(temp, "node"),
        '#!/bin/sh\nprintf \'%s\\n\' "$VSCODE_TEST_VERSION" "$@" >> "$NODE_MARKER"\nif [ "$VSCODE_TEST_VERSION" = 1.106.0 ]; then exit "$MINIMUM_STATUS"; fi\nexit "$STABLE_STATUS"\n',
        { mode: 0o755 }
      );
      const env = {
        ...process.env,
        ...guard.env,
        PATH: `${temp}:${process.env.PATH}`,
        NODE_MARKER: marker,
        COMPILE_STATUS: String(compileStatus),
        MINIMUM_STATUS: String(minimumStatus),
        STABLE_STATUS: String(stableStatus),
        R_OMITTABLE: "true",
        PYTHON_OMITTABLE: "true",
        GITHUB_STEP_SUMMARY: summary
      };
      if (docsOnly === undefined) delete env.DOCS_ONLY;
      else env.DOCS_ONLY = docsOnly;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 10_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus);
      assert.equal(
        readFileSync(marker, "utf8"),
        (docsOnly === "false" ? "npm\nrun\nbuild:test-extension\n" : "") +
          versions.map((version) => `${version}\nscripts/run-packaged-editor-tests.mjs\nopenwrangler.vsix\n`).join("")
      );
      if (docsOnly === "true") {
        assert.match(
          readFileSync(summary, "utf8"),
          /Installed VS Code smoke omitted:.*No fresh installed-editor execution is claimed/u
        );
      } else {
        assert.equal(readFileSync(summary, "utf8"), "");
      }
    });
  }
});

test("Python keeps its full checks and installs Spark unless the exact proof permits omission", async (context) => {
  const job = workflow.jobs["python-runtime"];
  const guard = job.steps.find((step) => step.name === "Install Python test dependencies");
  assert.equal(guard.shell, "bash");
  assert.equal(guard.if, undefined);
  assert.equal(guard["continue-on-error"], undefined);
  assert.deepEqual(guard.env, {
    NATIVE_SPARK_OMITTABLE: "${{ needs.docs-proof.outputs.native_spark_omittable }}"
  });
  const guardIndex = job.steps.indexOf(guard);
  for (const command of ["npm ci --ignore-scripts", 'python -m pip install -e "python[dev]"']) {
    const index = job.steps.findIndex((step) => step.run === command);
    assert.ok(index >= 0 && index < guardIndex);
    assert.equal(job.steps[index].if, undefined);
  }
  assert.deepEqual(job.steps.find((step) => step.uses?.startsWith("actions/setup-java@")).with, {
    distribution: "temurin",
    "java-version": "17",
    "verify-signature": true
  });
  assert.deepEqual(
    job.steps.slice(guardIndex + 1).map((step) => step.run),
    [
      "python -m ruff check python scripts/r-contract-signal.py\npython -m ruff format --check python scripts/r-contract-signal.py\n",
      "node scripts/run-pyright.mjs python",
      "python -m pytest python/tests -q --durations=20"
    ]
  );
  for (const step of job.steps.slice(guardIndex + 1)) {
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  for (const [omittable, pipStatus, expectedStatus] of [
    ["true", 0, 0],
    ["false", 0, 0],
    ["true", 37, 37],
    ["false", 38, 38],
    [undefined, 0, 1],
    ["", 0, 1],
    ["TRUE", 0, 1],
    ["true\nfalse", 0, 1]
  ]) {
    await context.test(`${JSON.stringify(omittable)}/pip=${pipStatus}`, (child) => {
      const temp = mkdtempSync(join(tmpdir(), "openwrangler-ci-spark-"));
      child.after(() => rmSync(temp, { recursive: true, force: true }));
      const marker = join(temp, "invocation");
      const summary = join(temp, "summary");
      writeFileSync(marker, "");
      writeFileSync(summary, "");
      writeFileSync(
        join(temp, "python"),
        '#!/bin/sh\nprintf \'%s\\n\' "$@" >> "$COMMAND_MARKER"\nexit "$PIP_STATUS"\n',
        { mode: 0o755 }
      );
      const env = {
        ...process.env,
        PATH: `${temp}:${process.env.PATH}`,
        COMMAND_MARKER: marker,
        PIP_STATUS: String(pipStatus),
        GITHUB_STEP_SUMMARY: summary
      };
      if (omittable === undefined) delete env.NATIVE_SPARK_OMITTABLE;
      else env.NATIVE_SPARK_OMITTABLE = omittable;
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
        cwd: temp,
        env,
        encoding: "utf8",
        timeout: 10_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, expectedStatus);
      assert.deepEqual(
        readFileSync(marker, "utf8").split("\n").filter(Boolean),
        omittable === "true" || omittable === "false"
          ? ["-m", "pip", "install", "pandas>=2.2,<3.0", ...(omittable === "false" ? ["pyspark[connect]==4.2.0"] : [])]
          : []
      );
      if (omittable === "true" && pipStatus === 0) {
        assert.match(readFileSync(summary, "utf8"), /no fresh native Spark execution is claimed/u);
      } else {
        assert.equal(readFileSync(summary, "utf8"), "");
      }
    });
  }
});

test("required runtime results reject missing proof and incomplete or canceled execution", (context) => {
  assert.deepEqual(workflow.jobs["docs-proof"].outputs, {
    docs_only: "${{ steps.proof.outputs.docs_only }}",
    r_omittable: "${{ steps.proof.outputs.r_omittable }}",
    r_runtime_omittable: "${{ steps.proof.outputs.r_runtime_omittable }}",
    python_omittable: "${{ steps.proof.outputs.python_omittable }}",
    r_editor_omittable: "${{ steps.proof.outputs.r_editor_omittable }}",
    native_spark_omittable: "${{ steps.proof.outputs.native_spark_omittable }}"
  });
  const temp = mkdtempSync(join(tmpdir(), "openwrangler-ci-guards-"));
  context.after(() => rmSync(temp, { recursive: true, force: true }));
  const expectedNames = {
    python: "Python runtime contracts",
    r: "Native R frame, kernel, and transport contracts",
    windows: "Windows filesystem and process contracts"
  };
  for (const [id, name] of Object.entries(expectedNames)) {
    const job = workflow.jobs[id];
    const runtimeId = `${id}-runtime`;
    const runtime = workflow.jobs[runtimeId];
    assert.equal(job.name, name);
    assert.equal(Object.values(workflow.jobs).filter((candidate) => candidate.name === name).length, 1);
    assert.deepEqual(job.needs, ["docs-proof", runtimeId, ...(id === "r" ? ["r-macos", "r-windows"] : [])]);
    assert.equal(job.if, "${{ always() }}", "failed or canceled dependencies must not skip required jobs");
    assert.equal(job.steps.length, 1, "required result jobs must not retain expensive work after cancellation");
    const [guard] = job.steps;
    assert.equal(guard.if, undefined);
    assert.equal(guard.shell, "bash");
    assert.equal(guard.env.PROOF_RESULT, "${{ needs.docs-proof.result }}");
    const omissionOutputs =
      id === "windows"
        ? ["r_runtime_omittable", "python_omittable"]
        : id === "r"
          ? ["r_omittable", "r_runtime_omittable"]
          : ["python_omittable"];
    for (const output of omissionOutputs) {
      assert.equal(guard.env[output.toUpperCase()], `\${{ needs.docs-proof.outputs.${output} }}`);
    }
    for (const other of ["DOCS_ONLY", "R_OMITTABLE", "R_RUNTIME_OMITTABLE", "PYTHON_OMITTABLE"]) {
      if (!omissionOutputs.includes(other.toLowerCase())) assert.equal(guard.env[other], undefined);
    }
    assert.equal(guard.env.RUNTIME_RESULT, `\${{ needs.${runtimeId}.result }}`);
    assert.equal(runtime.needs, "docs-proof");
    assert.equal(
      runtime.if,
      id === "windows"
        ? "${{ !cancelled() && needs.docs-proof.result == 'success' && (needs.docs-proof.outputs.r_runtime_omittable == 'false' || needs.docs-proof.outputs.python_omittable == 'false') }}"
        : `\${{ !cancelled() && needs.docs-proof.result == 'success' && needs.docs-proof.outputs.${id === "r" ? "r_runtime" : id}_omittable == 'false' }}`,
      "execution jobs must be cancellable, including while queued after a successful proof"
    );
    assert.equal(runtime["runs-on"], id === "windows" ? "windows-latest" : "ubuntu-24.04");
    assert.equal(runtime.steps[0].if, undefined);
    assert.equal(runtime.steps.at(-1).if, undefined);
    for (const [result, omittable, runtimeResult, expectedStatus, otherOmittable = omittable] of [
      ["success", "true", "skipped", 0],
      ["success", "false", "success", 0],
      ["failure", "true", "skipped", 1],
      ["skipped", "true", "skipped", 1],
      ["cancelled", "false", "skipped", 1],
      ["failure", "false", "success", 1],
      ["success", "false", "skipped", 1],
      ["success", "false", "cancelled", 1],
      ["success", "false", "failure", 1],
      ["success", "false", "", 1],
      ["success", "true", "success", 1],
      ["success", "true", "failure", 1],
      ["success", "true", "cancelled", 1],
      ["success", "true", "", 1],
      ["success", "", "skipped", 1],
      ["success", "TRUE", "skipped", 1],
      ["success", "true\nfalse", "success", 1],
      ...(id === "windows"
        ? [
            ["success", "false", "success", 0, "true"],
            ["success", "true", "success", 0, "false"],
            ["success", "false", "skipped", 1, "true"],
            ["success", "true", "skipped", 1, "false"],
            ["success", "false", "success", 1, ""],
            ["success", "", "success", 1, "false"],
            ["success", "true", "skipped", 1, ""],
            ["success", "", "skipped", 1, "true"]
          ]
        : [])
    ]) {
      const summary = join(temp, "summary");
      rmSync(summary, { force: true });
      const execution = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
        env: {
          ...process.env,
          PROOF_RESULT: result,
          DOCS_ONLY: omittable === "true" ? "false" : "true",
          // Whole-R omission deliberately disagrees with the Windows source flag.
          R_OMITTABLE: id === "r" ? omittable : omittable === "true" ? "false" : "true",
          PYTHON_OMITTABLE:
            id === "windows" ? otherOmittable : id === "python" ? omittable : omittable === "true" ? "false" : "true",
          R_RUNTIME_OMITTABLE: omittable,
          RUNTIME_RESULT: runtimeResult,
          MACOS_CALL_RESULT: id === "r" && omittable === "true" ? "skipped" : "success",
          MACOS_RESULT: id === "r" && omittable === "true" ? "" : "success",
          WINDOWS_CALL_RESULT: id === "r" && omittable === "true" ? "skipped" : "success",
          WINDOWS_RESULT: id === "r" && omittable === "true" ? "" : "success",
          GITHUB_STEP_SUMMARY: summary
        },
        encoding: "utf8"
      });
      assert.equal(execution.error, undefined);
      assert.equal(execution.status, expectedStatus, `${id}: ${result}/${JSON.stringify(omittable)}/${runtimeResult}`);
      if (expectedStatus === 0 && omittable === "true" && (id !== "windows" || otherOmittable === "true")) {
        assert.match(
          readFileSync(summary, "utf8"),
          id === "r"
            ? /Native R checks omitted:.*No fresh R execution is claimed/u
            : id === "python"
              ? /Python checks omitted:.*No fresh Python execution is claimed/u
              : /Windows filesystem and process checks omitted:.*No fresh Windows source execution is claimed/u
        );
      }
    }
  }
});

test("required R result checks installed caller and selected platform outcomes independently", (context) => {
  const temp = mkdtempSync(join(tmpdir(), "openwrangler-ci-platform-guard-"));
  context.after(() => rmSync(temp, { recursive: true, force: true }));
  const guard = workflow.jobs.r.steps[0];
  const successful = {
    PROOF_RESULT: "success",
    DOCS_ONLY: "false",
    R_OMITTABLE: "false",
    R_RUNTIME_OMITTABLE: "false",
    RUNTIME_RESULT: "success",
    MACOS_CALL_RESULT: "success",
    MACOS_RESULT: "success",
    WINDOWS_CALL_RESULT: "success",
    WINDOWS_RESULT: "success"
  };
  const omitted = {
    ...successful,
    R_OMITTABLE: "true",
    R_RUNTIME_OMITTABLE: "true",
    RUNTIME_RESULT: "skipped",
    MACOS_CALL_RESULT: "skipped",
    MACOS_RESULT: "",
    WINDOWS_CALL_RESULT: "skipped",
    WINDOWS_RESULT: ""
  };
  const runtimeOmitted = { ...successful, R_RUNTIME_OMITTABLE: "true", RUNTIME_RESULT: "skipped" };
  const cases = [
    [successful, 0],
    [omitted, 0],
    [runtimeOmitted, 0],
    [{ ...omitted, DOCS_ONLY: "true" }, 0],
    [{ ...successful, R_OMITTABLE: "true", RUNTIME_RESULT: "skipped" }, 1]
  ];
  for (const platform of ["MACOS", "WINDOWS"]) {
    for (const suffix of ["CALL_RESULT", "RESULT"]) {
      const field = `${platform}_${suffix}`;
      for (const result of ["failure", "cancelled", "skipped", "", "unexpected", "success"]) {
        if (result !== "success") cases.push([{ ...successful, [field]: result }, 1]);
        if (result !== "success") cases.push([{ ...runtimeOmitted, [field]: result }, 1]);
        if (result !== omitted[field]) cases.push([{ ...omitted, [field]: result }, 1]);
      }
    }
  }
  cases.push(
    [{ ...omitted, PROOF_RESULT: "failure" }, 1],
    [{ ...omitted, R_OMITTABLE: "false", RUNTIME_RESULT: "success" }, 1],
    [{ ...omitted, R_OMITTABLE: "" }, 1],
    [{ ...omitted, R_OMITTABLE: "TRUE" }, 1]
  );
  for (const baseline of [successful, omitted, runtimeOmitted]) {
    for (const value of [undefined, "", "TRUE", "true\nfalse"]) {
      cases.push([{ ...baseline, R_RUNTIME_OMITTABLE: value }, 1]);
    }
    cases.push([{ ...baseline, R_RUNTIME_OMITTABLE: baseline.R_RUNTIME_OMITTABLE === "true" ? "false" : "true" }, 1]);
  }
  for (const result of ["failure", "cancelled", "skipped", ""]) {
    cases.push([{ ...runtimeOmitted, PROOF_RESULT: result }, 1]);
  }
  for (const result of ["success", "failure", "cancelled", "", "unexpected"]) {
    cases.push([{ ...runtimeOmitted, RUNTIME_RESULT: result }, 1]);
  }
  for (const [environment, status] of cases) {
    const summary = join(temp, "summary");
    rmSync(summary, { force: true });
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
      env: { ...process.env, ...environment, GITHUB_STEP_SUMMARY: summary },
      encoding: "utf8"
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, status, JSON.stringify(environment));
    if (environment === runtimeOmitted) {
      assert.match(readFileSync(summary, "utf8"), /Native R source checks omitted.*Both platform R jobs passed/u);
    }
  }
});

test("CI schedules every existing native R phase on two workers and cancellation once", () => {
  const runtime = workflow.jobs["r-runtime"];
  assert.equal(runtime.strategy?.["fail-fast"], false);
  const entries = runtime.strategy.matrix.include;
  assert.equal(entries.length, 2);
  const npmInstall = runtime.steps.filter((step) => step.run === "npm ci --ignore-scripts");
  assert.equal(npmInstall.length, 1);
  assert.equal(npmInstall[0].if, "${{ matrix.shard != 'kernel-agent' }}");
  const commands = runtime.steps.filter(
    (step) => step.run?.includes("scripts/run-r-contract-tests.mjs") || step.run === "npm run test:scripts:native"
  );
  assert.equal(commands.length, 2);
  const cancellation = commands.find((step) => step.run === "npm run test:scripts:native");
  assert.equal(cancellation.if, "${{ matrix.native_cancellation }}");
  const shard = commands.find((step) => step !== cancellation);
  assert.equal(shard.run, 'node scripts/run-r-contract-tests.mjs --shard "$R_CONTRACT_SHARD"');
  assert.equal(shard.if, undefined);
  assert.equal(shard.env.R_CONTRACT_SHARD, "${{ matrix.shard }}");
  assert.equal(shard.env.R_LIBS_USER, "${{ steps.r_prepare.outputs.library }}");
  const phases = createRContractPhases({ environment: {}, r: "unused-R", rscript: "unused-Rscript" });
  const kernelTransport = phases.find((phase) => phase.id === "kernel-transport");
  assert.deepEqual(kernelTransport.args.slice(2), [
    "src/test/rKernelTransport.cross.test.ts",
    "src/test/rKernelTransport.unit.test.ts",
    "src/test/rNotebookVariableDiscovery.unit.test.ts",
    "--maxWorkers=1",
    "--reporter=verbose"
  ]);
  assert.equal(kernelTransport.environment.OPEN_WRANGLER_R_CONTRACT_TESTS, "1");
  assert.equal(kernelTransport.environment.RSCRIPT, "unused-Rscript");
  const csvPhases = selectRContractPhases(phases, { kind: "phase", id: "kernel:csv-import" });
  assert.equal(csvPhases.length, 1);
  assert.equal(csvPhases[0].timeoutMs, 120_000);
  assert.equal(csvPhases[0].environment.OPEN_WRANGLER_R_KERNEL_CASE, "csv-import");
  const scheduled = [];
  for (const entry of entries) {
    assert.equal(typeof entry.native_cancellation, "boolean");
    const selected = selectRContractPhases(phases, { kind: "shard", id: entry.shard });
    if (entry.shard === "kernel-agent") {
      assert.equal(entry.native_cancellation, false);
      assert.ok(selected.every((phase) => phase.command === "unused-Rscript"));
    }
    scheduled.push(...selected.map((phase) => phase.id));
  }
  assert.equal(entries.filter((entry) => entry.native_cancellation).length, 1);
  assert.equal(scheduled.filter((id) => id === "kernel:csv-import").length, 1);
  assert.deepEqual(scheduled.sort(), phases.map((phase) => phase.id).sort());
});

test("cross-platform installed investigation omits only independent source qualification", () => {
  const crossPlatform = load(
    readFileSync(resolve(import.meta.dirname, "../.github/workflows/cross-platform.yml"), "utf8")
  );
  const full = "${{ github.event_name != 'workflow_dispatch' || inputs.installed_only != true }}";
  assert.equal(
    crossPlatform.jobs["r-4-4-scheduled-qualification"].if,
    "${{ !cancelled() && (github.event_name != 'workflow_dispatch' || inputs.installed_only != true) }}"
  );
  for (const id of ["dependency-guard-windows", "python-runtime-dependency-cohorts"])
    assert.equal(crossPlatform.jobs[id].if, full);
  assert.deepEqual(Object.keys(crossPlatform.on).sort(), ["schedule", "workflow_dispatch"]);
  const inputs = crossPlatform.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ["installed_only"]);
  assert.equal(inputs.installed_only.type, "boolean");
  assert.equal(inputs.installed_only.default, false);
  assert.equal(
    crossPlatform["run-name"],
    "${{ github.event_name == 'workflow_dispatch' && inputs.installed_only == true && 'Installed macOS/Windows investigation; full qualification omitted' || 'Cross-platform runtime' }}"
  );
  assert.deepEqual(Object.keys(crossPlatform.jobs), [
    "runtime",
    "dependency-guard-windows",
    "python-runtime-dependency-cohorts",
    "r-4-4-scheduled-qualification"
  ]);
  const runtime = crossPlatform.jobs.runtime;
  assert.equal(runtime.if, undefined);
  assert.deepEqual(runtime.strategy.matrix.include, [
    { os: "macos-latest", python: "3.12" },
    { os: "windows-latest", python: "3.14" }
  ]);
  assert.deepEqual(
    runtime.steps.filter((step) => step.run).map((step) => step.run),
    [
      "npm ci --ignore-scripts",
      'python -m pip install -e "python[dev]"',
      "npm run test:python-environment-smoke",
      "python -m pytest python/tests -q",
      "npm run build",
      "npm run package:prepared -- --out openwrangler.vsix",
      "npm run verify:vsix -- openwrangler.vsix",
      "npm run build:test-extension",
      "node scripts/run-packaged-editor-tests.mjs openwrangler.vsix",
      "npm run test:scripts:native"
    ]
  );
  assert.deepEqual(
    runtime.steps.filter((step) => step.if).map((step) => [step.run ?? step.name, step.if]),
    [
      ["python -m pytest python/tests -q", full],
      [
        "Upload packaged-editor failure diagnostics",
        "${{ !cancelled() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}"
      ],
      ["npm run test:scripts:native", "${{ runner.os == 'Windows' }}"]
    ]
  );
  assert.deepEqual(runtime.steps.find((step) => step.id === "packaged_editor").env, {
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_PACKAGED_MODE: "full",
    VSCODE_TEST_VERSION: "stable"
  });
});

test("released Jupyter investigation targets preserve installed R calls and actual platform results", () => {
  assert.deepEqual(Object.keys(releasedJupyter.on).sort(), ["workflow_call", "workflow_dispatch"]);
  assert.deepEqual(releasedJupyter.on.workflow_dispatch.inputs.target.options, [
    "linux-all",
    "linux-python",
    "linux-r",
    "macos-r",
    "windows-r"
  ]);
  assert.equal(releasedJupyter.on.workflow_dispatch.inputs.target.default, "linux-all");
  const linux = releasedJupyter.jobs.vscode;
  assert.equal(
    linux.if,
    "${{ inputs.target == 'linux-all' || (github.event_name == 'workflow_dispatch' && (inputs.target == 'linux-python' || inputs.target == 'linux-r')) }}"
  );
  assert.equal(
    linux.name,
    "${{ inputs.target == 'linux-python' && 'Local Python notebooks and files in VS Code; Spark, remote and R omitted' || inputs.target == 'linux-r' && 'R investigation in VS Code and Cursor; Python/file-input checks omitted' || 'Released Jupyter in VS Code and Cursor' }}"
  );
  assert.equal(linux["timeout-minutes"], 90);
  const rOnly =
    "${{ inputs.target == 'linux-all' || (github.event_name == 'workflow_dispatch' && inputs.target == 'linux-r') }}";
  assert.deepEqual(
    linux.steps.filter((step) => step.if === rOnly).map((step) => step.id ?? step.uses.split("@")[0]),
    [
      "r-lib/actions/setup-r",
      "rscript",
      "packaged_editor_r",
      "packaged_editor_r_values",
      "packaged_editor_r_categorical",
      "packaged_editor_r_interactive"
    ]
  );
  const remotePreparation = [
    linux.steps.find((step) => step.uses?.startsWith("actions/setup-java@")),
    linux.steps.find((step) => step.run?.startsWith("python -m pip install --no-deps ")),
    linux.steps.find((step) => step.run === "npm run lock:remote-jupyter:check"),
    linux.steps.find((step) => step.run === "npm run audit:remote-jupyter")
  ];
  for (const step of remotePreparation) {
    assert.ok(step);
    assert.equal(step.if, "${{ github.event_name != 'workflow_dispatch' || inputs.target != 'linux-python' }}");
  }
  for (const step of linux.steps) {
    if (
      step.if === rOnly ||
      remotePreparation.includes(step) ||
      step.id === "packaged_editor" ||
      step.uses?.startsWith("actions/upload-artifact@") ||
      step.run === "exit 1"
    )
      continue;
    assert.equal(step.if, undefined, step.name ?? step.run ?? step.uses);
  }
  const python = linux.steps.find((step) => step.id === "packaged_editor");
  assert.equal(python.if, "${{ inputs.target != 'linux-r' }}");
  assert.equal(
    python.name,
    "${{ inputs.target == 'linux-python' && 'Test local Python notebooks and files in packaged VS Code' || 'Test remote Python Jupyter in packaged VS Code' }}"
  );
  assert.equal(python.shell, "bash");
  assert.equal(
    python.run,
    [
      "set -euo pipefail",
      'if [[ "$ACCEPTANCE_TARGET" == "linux-python" ]]; then',
      "  export OPEN_WRANGLER_PACKAGED_MODE=full",
      "  export OPEN_WRANGLER_REAL_REMOTE_JUPYTER=0",
      "  OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE=python-notebooks \\",
      "    /usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix",
      "  unset OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE",
      "  export OPEN_WRANGLER_REAL_JUPYTER_EXTENSION=0",
      "fi",
      "/usr/bin/dbus-run-session -- node scripts/run-packaged-editor-tests.mjs openwrangler.vsix",
      ""
    ].join("\n")
  );
  assert.equal(python["continue-on-error"], undefined);
  assert.deepEqual(python.env, {
    ACCEPTANCE_TARGET: "${{ inputs.target }}",
    OPEN_WRANGLER_PACKAGED_EDITORS: "vscode",
    OPEN_WRANGLER_EDITOR_DISPLAY: "xvfb",
    OPEN_WRANGLER_REAL_JUPYTER_EXTENSION: "1",
    OPEN_WRANGLER_REAL_REMOTE_JUPYTER: "1",
    VSCODE_TEST_VERSION: "stable"
  });
  const pythonDiagnostics = linux.steps[linux.steps.indexOf(python) + 1];
  assert.equal(
    pythonDiagnostics.if,
    "${{ always() && steps.packaged_editor.outcome == 'failure' && steps.packaged_editor.outputs.evidence_ready == 'true' }}"
  );
  assert.equal(pythonDiagnostics.with.path, "${{ steps.packaged_editor.outputs.evidence_path }}");
  assert.equal(releasedJupyter.on.workflow_call.inputs.target.type, "string");
  assert.equal(releasedJupyter.on.workflow_call.inputs.target.required, true);
  assert.equal(releasedJupyter.on.workflow_call.inputs.omit_editor.type, "boolean");
  assert.equal(releasedJupyter.on.workflow_call.inputs.omit_editor.default, false);
  assert.equal(releasedJupyter.on.workflow_dispatch.inputs.omit_editor, undefined);
  assert.equal(releasedJupyter.on.workflow_call.inputs.omit_source?.type, "boolean");
  assert.equal(releasedJupyter.on.workflow_call.inputs.omit_source.default, false);
  assert.equal(releasedJupyter.on.workflow_dispatch.inputs.omit_source, undefined);
  assert.deepEqual(releasedJupyter.permissions, { contents: "read" });
  const guard = workflow.jobs.r.steps[0];
  for (const [id, target, prefix] of [
    ["r-macos", "macos-r", "MACOS"],
    ["r-windows", "windows-r", "WINDOWS"]
  ]) {
    const caller = workflow.jobs[id];
    const output = `${target.split("-")[0]}_result`;
    assert.equal(caller.needs, "docs-proof");
    assert.equal(
      caller.if,
      "${{ !cancelled() && needs.docs-proof.result == 'success' && needs.docs-proof.outputs.r_omittable == 'false' }}"
    );
    assert.equal(caller.uses, "./.github/workflows/released-jupyter.yml");
    assert.deepEqual(caller.with, {
      target,
      omit_editor: "${{ needs.docs-proof.outputs.r_editor_omittable == 'true' }}",
      omit_source: "${{ needs.docs-proof.outputs.r_runtime_omittable == 'true' }}"
    });
    assert.equal(guard.env[`${prefix}_CALL_RESULT`], `\${{ needs.${id}.result }}`);
    assert.equal(guard.env[`${prefix}_RESULT`], `\${{ needs.${id}.outputs.${output} }}`);
    assert.equal(releasedJupyter.on.workflow_call.outputs[output].value, `\${{ jobs.${target}.result }}`);
    const platform = releasedJupyter.jobs[target];
    assert.equal(platform.if, `\${{ inputs.target == '${target}' }}`);
    assert.equal(platform.steps[0].with.ref, "${{ github.sha }}");
    assert.equal(platform.steps[0].with["persist-credentials"], false);
    const editor = platform.steps.find((step) => step.id === "packaged_editor_r");
    const omission = platform.steps.find((step) => step.name === "Record omitted R editor journey");
    const source = platform.steps.find((step) => step.name === "Check native R numeric and CSV portability");
    const sourceOmission = platform.steps.find((step) => step.name === "Record omitted R source check");
    assert.equal(editor.if, "${{ !inputs.omit_editor }}");
    assert.equal(editor.run, "node scripts/run-packaged-editor-tests.mjs openwrangler.vsix");
    assert.equal(editor["continue-on-error"], undefined);
    assert.equal(omission.if, "${{ inputs.omit_editor }}");
    assert.match(omission.run, /no fresh editor execution is claimed/u);
    assert.equal(source.if, "${{ !inputs.omit_source }}");
    assert.match(source.run, /for \(const id of \["kernel:numeric-portability", "kernel:csv-import"\]\)/u);
    assert.equal(sourceOmission.if, "${{ inputs.omit_source }}");
    assert.match(sourceOmission.run, /no fresh numeric or CSV source execution is claimed/u);
    for (const step of platform.steps) {
      assert.equal(step["continue-on-error"], undefined);
      if (
        step === editor ||
        step === omission ||
        step === source ||
        step === sourceOmission ||
        step.uses?.startsWith("actions/upload-artifact@")
      )
        continue;
      assert.equal(step.if, undefined, `${target}: ${step.name ?? step.run ?? step.uses}`);
    }
  }
  const concurrencyGroups = ["workflow_dispatch", "pull_request"].flatMap((event) =>
    ["macos-r", "windows-r"].map((target) =>
      releasedJupyter.concurrency.group
        .replaceAll("${{ github.event_name }}", event)
        .replaceAll("${{ github.ref }}", "refs/heads/same-source")
        .replaceAll("${{ inputs.target }}", target)
    )
  );
  assert.equal(new Set(concurrencyGroups).size, 4, "manual runs and the two CI calls must not cancel one another");
  assert.equal(
    concurrencyGroups.includes(workflow.concurrency.group.replaceAll("${{ github.event.pull_request.number }}", "123")),
    false
  );
});
