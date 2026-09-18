import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeOmissionScriptFiles = new Set([
  "scripts/ci-docs-only.test.mjs",
  "scripts/capture-screenshots.mjs",
  "scripts/capture-screenshots-readiness.mjs",
  "scripts/compose-readme-media.mjs",
  "scripts/test-webview-accessibility.mjs",
  "scripts/release-metadata.mjs",
  "scripts/release-documents.mjs",
  "scripts/release-readiness.mjs",
  "scripts/create-canonical-release-artifact.test.mjs",
  "scripts/daily-preview-artifact.mjs",
  "scripts/daily-preview-artifact.test.mjs",
  "scripts/prepare-stable-candidate-tag.mjs",
  "scripts/prepare-stable-candidate-tag.test.mjs",
  "scripts/release-tag-publisher.mjs",
  "scripts/push-stable-release-tag.mjs",
  "scripts/push-stable-release-tag.test.mjs",
  "scripts/publish-github-stable-release.mjs",
  "scripts/publish-github-stable-release.test.mjs",
  "scripts/registry-release-source.test.mjs",
  "scripts/verify-registry-release-artifact.test.mjs",
  "scripts/verify-canonical-release-artifact.mjs",
  "scripts/verify-canonical-release-artifact.test.mjs"
]);

const rEditorOmissionTestFiles = new Set(["r/tests/kernel_agent.R", "r/tests/frame_contract.R"]);
const hostSourceOmissionFiles = new Set([
  "src/extension/nativeViews.ts",
  "src/extension/nativeViewsExportOptions.ts",
  "src/test/nativeViewStateCommands.unit.test.ts",
  "src/test/nativeViewExportCommands.unit.test.ts",
  "src/extension/files/importOptions.ts",
  "src/test/importOptions.unit.test.ts",
  "src/test/webviewPanel.unit.test.ts"
]);
const nativeSparkOmissionFiles = new Set([
  "python/openwrangler_runtime/engines/_pandas_arrow_formula_helpers.py",
  "python/openwrangler_runtime/engines/pandas_engine.py",
  "python/openwrangler_runtime/engines/duckdb_engine.py",
  "python/tests/test_pandas_engine.py",
  "python/tests/test_filter_logic.py",
  "python/tests/test_duckdb_engine.py",
  "python/tests/test_split_text_columns.py",
  "python/tests/test_operation_edges.py",
  "python/tests/test_operations.py",
  "python/tests/test_session_transactions.py"
]);

export function proveRuntimeOmissions({ cwd = process.cwd(), env = process.env } = {}) {
  const required = {
    docsOnly: false,
    rOmittable: false,
    rRuntimeOmittable: false,
    pythonOmittable: false,
    rEditorOmittable: false,
    nativeSparkOmittable: false
  };
  const { CI_EVENT, CI_BASE_REF, CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA } = env;
  if (
    CI_EVENT !== "pull_request" ||
    CI_BASE_REF !== "main" ||
    ![CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha))
  ) {
    return required;
  }

  let identity;
  let diff;
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    identity = git(["show", "--no-patch", "--format=%H%n%P", "HEAD"]).toString("ascii").trim();
    if (identity !== `${CI_MERGE_SHA}\n${CI_BASE_SHA} ${CI_HEAD_SHA}`) return required;
    diff = git([
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      CI_BASE_SHA,
      CI_MERGE_SHA,
      "--"
    ]);
  } catch {
    // Missing history, failed Git commands, and oversized output require the full owners.
    return required;
  }

  const text = diff.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(diff)) return required;
  const records = text.split("\0");
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return required;
  let docsOnly = true;
  let documentationOnlyRequired = false;
  let rOmittable = true;
  let rRuntimeOmittable = true;
  let pythonOmittable = true;
  let rEditorOmittable = true;
  let nativeSparkOmittable = true;
  for (let index = 0; index < records.length; index += 2) {
    const modified = /^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M$/u.test(records[index]);
    const added = /^:000000 100644 0{40} [0-9a-f]{40} A$/u.test(records[index]);
    const deleted = /^:100644 000000 [0-9a-f]{40} 0{40} D$/u.test(records[index]);
    const path = records[index + 1];
    const markdown =
      path === "README.md" ||
      path === "CHANGELOG.md" ||
      path === "CONTRIBUTING.md" ||
      path === "AGENTS.md" ||
      /^docs\/[^\p{Cc}]+\.md$/u.test(path);
    const reportData = /^docs\/performance\/[^\p{Cc}]+\.json$/u.test(path);
    if ((markdown || reportData) && (modified || added || deleted)) {
      documentationOnlyRequired ||= !modified || reportData;
      continue;
    }
    const pythonSource = /^python\/(?:openwrangler_runtime|tests)\/[^\p{Cc}]+\.py$/u.test(path);
    const rSource = /^r\/(?:openwrangler_runtime|tests)\/[^\p{Cc}]+\.R$/u.test(path);
    // Only regular runtime/test source additions may omit the other runtime; their deletions still exclude renames.
    if (!modified && !((pythonSource || rSource) && added)) {
      return required;
    }
    nativeSparkOmittable &&= modified && nativeSparkOmissionFiles.has(path);
    docsOnly = false;
    const webviewSource = modified && /^src\/webviews\/[^\p{Cc}]+$/u.test(path);
    const componentTest = modified && /^src\/test\/[^/\p{Cc}]+\.component\.test\.tsx$/u.test(path);
    const hostSource = modified && hostSourceOmissionFiles.has(path);
    rRuntimeOmittable &&= webviewSource || componentTest || hostSource;
    if (modified && rEditorOmissionTestFiles.has(path)) {
      rOmittable = false;
      continue;
    }
    rEditorOmittable = false;
    if (
      componentTest ||
      (modified && runtimeOmissionScriptFiles.has(path)) ||
      (modified && /^docs\/images\/[^\p{Cc}]+\.png$/u.test(path))
    )
      continue;
    if (pythonSource) {
      pythonOmittable = false;
      continue;
    }
    if (
      rSource ||
      webviewSource ||
      hostSource ||
      (modified &&
        (path === "src/test/progressiveProfilingLifecycle.unit.test.tsx" ||
          /^src\/test\/extensionHost\/[^/\p{Cc}]+\.ts$/u.test(path) ||
          path === "scripts/editor-acceptance.mjs" ||
          path === "scripts/editor-acceptance-artifact.test.mjs"))
    ) {
      rOmittable = false;
      continue;
    }
    return required;
  }
  if (documentationOnlyRequired && !docsOnly) return required;
  return {
    docsOnly,
    rOmittable,
    rRuntimeOmittable: rOmittable || rRuntimeOmittable,
    pythonOmittable,
    rEditorOmittable: !docsOnly && rEditorOmittable,
    nativeSparkOmittable: !docsOnly && nativeSparkOmittable
  };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("The CI documentation proof takes no arguments.");
  const { docsOnly, rOmittable, rRuntimeOmittable, pythonOmittable, rEditorOmittable, nativeSparkOmittable } =
    proveRuntimeOmissions();
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `docs_only=${docsOnly}\nr_omittable=${rOmittable}\nr_runtime_omittable=${rRuntimeOmittable}\npython_omittable=${pythonOmittable}\nr_editor_omittable=${rEditorOmittable}\nnative_spark_omittable=${nativeSparkOmittable}\n`
  );
  console.log(
    docsOnly
      ? "Verified documentation-only changes."
      : rEditorOmittable
        ? "Verified R test edits permit omission of installed R editor journeys; source checks remain required."
        : rOmittable && pythonOmittable
          ? "Verified edits permit omission of Python, R and Windows runtime checks."
          : rOmittable
            ? "Verified changes independent of native R."
            : rRuntimeOmittable
              ? "Verified selected host and renderer edits permit omission of Python, native R source and Windows filesystem and process checks; platform artifact, package and installed-editor checks remain required."
              : pythonOmittable
                ? "Verified edits permit omission of the Python worker; R, editor and Windows checks remain required."
                : "Full runtime checks required."
  );
}
