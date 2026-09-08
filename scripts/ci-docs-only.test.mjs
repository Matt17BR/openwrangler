import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { load } from "js-yaml";
import { proveRuntimeOmissions } from "./ci-docs-only.mjs";

const script = resolve(import.meta.dirname, "ci-docs-only.mjs");
const workflow = load(readFileSync(resolve(import.meta.dirname, "../.github/workflows/ci.yml"), "utf8"));

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024
  }).trim();
}

function write(cwd, file, text = "updated\n") {
  mkdirSync(dirname(join(cwd, file)), { recursive: true });
  writeFileSync(join(cwd, file), text);
}

function repository(context, extraFiles = []) {
  const cwd = mkdtempSync(join(tmpdir(), "openwrangler-ci-docs-"));
  context.after(() => rmSync(cwd, { recursive: true, force: true }));
  git(cwd, "init", "--quiet", "--initial-branch=main");
  git(cwd, "config", "user.email", "ci-test@openwrangler.invalid");
  git(cwd, "config", "user.name", "Open Wrangler CI Test");
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

test("proves existing README and nested Markdown edits against the exact tested merge", (context) => {
  const cwd = repository(context, ["docs/guides/über view.md"]);
  for (const file of ["README.md", "docs/testing.md", "docs/guides/über view.md"]) write(cwd, file);
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: true, rOmittable: true });
  const output = join(cwd, "action-output");
  execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
  assert.equal(readFileSync(output, "utf8"), "docs_only=true\nr_omittable=true\n");
});

test("proves existing Python source and Markdown edits only for native R", async (context) => {
  const cases = [
    ["python/openwrangler_runtime/engines/duckdb_engine.py"],
    ["python/openwrangler_runtime/protocol.py"],
    ["python/openwrangler_runtime/session.py"],
    ["python/tests/test_duckdb_engine.py"],
    ["python/tests/conftest.py"],
    ["CHANGELOG.md"],
    [
      "python/openwrangler_runtime/engines/duckdb_engine.py",
      "python/tests/test_duckdb_engine.py",
      "README.md",
      "CHANGELOG.md",
      "docs/architecture.md"
    ]
  ];
  for (const files of cases) {
    await context.test(files.join(", "), (child) => {
      const cwd = repository(child, files);
      for (const file of files) write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: true });
      const output = join(cwd, "action-output");
      execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
      assert.equal(readFileSync(output, "utf8"), "docs_only=false\nr_omittable=true\n");
    });
  }
});

test("requires native R for added, deleted or renamed Python source", async (context) => {
  const file = "python/openwrangler_runtime/session.py";
  for (const change of ["add", "delete", "rename", "rename into Python"]) {
    await context.test(change, (child) => {
      const cwd = repository(child, [file]);
      if (change === "add") write(cwd, "python/tests/new_test.py");
      if (change === "delete") rmSync(join(cwd, file));
      if (change === "rename") renameSync(join(cwd, file), join(cwd, "python/openwrangler_runtime/renamed.py"));
      if (change === "rename into Python")
        renameSync(join(cwd, "src/runtime.py"), join(cwd, "python/openwrangler_runtime/moved.py"));
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
    });
  }
});

test("requires native R for Python mode changes and existing executable or symlink entries", async (context) => {
  const file = "python/tests/helper.py";
  for (const mode of ["100755", "120000"]) {
    for (const existing of [false, true]) {
      await context.test(`${mode}, existing=${existing}`, (child) => {
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
        assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
      });
    }
  }
});

test("requires native R for control characters in an existing Python path", (context) => {
  const file = "python/tests/unusual\nname.py";
  const cwd = repository(context, [file]);
  write(cwd, file);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env: merge(cwd) }), { docsOnly: false, rOmittable: false });
});

test("requires full owners for runtime, metadata, fixture, workflow and script changes", async (context) => {
  for (const file of [
    "src/runtime.py",
    "package.json",
    "fixtures/example.csv",
    ".github/workflows/ci.yml",
    "scripts/ci-docs-only.mjs",
    "docs/example.py",
    "docs/image.svg",
    "CONTRIBUTING.md",
    "src/shared/protocol.ts",
    "src/extension/r/rKernelBridge.ts",
    "fixtures/view-literal-contract.json",
    "scripts/r-contract-signal.py",
    "scripts/ci-docs-only.test.mjs",
    "package-lock.json",
    "python/pyproject.toml",
    "python/README.md",
    "python/openwrangler_runtime.py",
    "python/tests-extra/helper.py",
    "python/tests/helper.PY",
    "python/openwrangler_runtime/helper.py.bak",
    "vite.config.mts",
    ".npmrc",
    "r/openwrangler_runtime/frame_contract.R"
  ]) {
    await context.test(file, (child) => {
      const cwd = repository(child, [file]);
      write(cwd, "README.md");
      write(cwd, file);
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
    });
  }
});

test("does not hide deletions or renames behind a Markdown destination", async (context) => {
  for (const change of ["add docs", "delete docs", "delete runtime", "rename docs", "rename runtime"]) {
    await context.test(change, (child) => {
      const cwd = repository(child);
      if (change === "add docs") write(cwd, "docs/new.md");
      if (change === "delete docs") rmSync(join(cwd, "docs/testing.md"));
      if (change === "delete runtime") rmSync(join(cwd, "src/runtime.py"));
      if (change === "rename docs") renameSync(join(cwd, "docs/testing.md"), join(cwd, "docs/renamed.md"));
      if (change === "rename runtime") renameSync(join(cwd, "src/runtime.py"), join(cwd, "docs/runtime.md"));
      const env = merge(cwd);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
    });
  }
});

test("requires full owners for executable or symlink Markdown entries", async (context) => {
  for (const mode of ["100755", "120000"]) {
    await context.test(mode, (child) => {
      const cwd = repository(child);
      const blob = git(cwd, "rev-parse", "HEAD:README.md");
      git(cwd, "update-index", "--cacheinfo", `${mode},${blob},README.md`);
      const env = merge(cwd, false);
      assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
    });
  }
});

test("handles NUL-delimited paths without treating newline paths as documentation", (context) => {
  const file = "docs/unusual\nname.md";
  const cwd = repository(context, [file]);
  write(cwd, file);
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
});

test("examines changes beyond a 300-file API or workflow filter limit", (context) => {
  const files = Array.from({ length: 310 }, (_, index) => `docs/page-${index}.md`);
  const cwd = repository(context, files);
  for (const file of files) write(cwd, file);
  write(cwd, "src/runtime.py");
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
});

test("falls back to full owners when the bounded Git output is exceeded", (context) => {
  const files = Array.from({ length: 1500 }, (_, index) => `docs/${"a".repeat(100)}-${index}.md`);
  const cwd = repository(context, files);
  for (const file of files) write(cwd, file);
  const env = merge(cwd);
  assert.ok(git(cwd, "diff", "--raw", "--no-abbrev", "-z", env.CI_BASE_SHA, env.CI_MERGE_SHA).length > 256 * 1024);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
});

test("requires exact event identities, protected base and two merge parents", (context) => {
  const cwd = repository(context);
  write(cwd, "README.md");
  const env = merge(cwd);
  for (const change of [
    { CI_EVENT: "push" },
    { CI_EVENT: "merge_group" },
    { CI_BASE_REF: "release" },
    { CI_BASE_SHA: undefined },
    { CI_HEAD_SHA: "invalid" },
    { CI_MERGE_SHA: "a".repeat(40) },
    { CI_BASE_SHA: env.CI_HEAD_SHA, CI_HEAD_SHA: env.CI_BASE_SHA }
  ]) {
    assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, ...change } }), {
      docsOnly: false,
      rOmittable: false
    });
  }
  git(cwd, "checkout", "--quiet", env.CI_HEAD_SHA);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
  assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, CI_MERGE_SHA: env.CI_HEAD_SHA } }), {
    docsOnly: false,
    rOmittable: false
  });
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
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: true, rOmittable: true });
  assert.deepEqual(proveRuntimeOmissions({ cwd, env: { ...env, CI_BASE_SHA: earlierBase } }), {
    docsOnly: false,
    rOmittable: false
  });
});

test("depth two is sufficient while missing merge history requires full checks", (context) => {
  const cwd = repository(context);
  write(cwd, "README.md");
  const env = merge(cwd);
  for (const depth of [1, 2]) {
    const clone = mkdtempSync(join(tmpdir(), "openwrangler-ci-clone-"));
    context.after(() => rmSync(clone, { recursive: true, force: true }));
    git(cwd, "clone", "--quiet", "--depth", String(depth), pathToFileURL(cwd).href, clone);
    assert.deepEqual(proveRuntimeOmissions({ cwd: clone, env }), { docsOnly: depth === 2, rOmittable: depth === 2 });
  }
});

test("empty diffs and Git failures select full checks", (context) => {
  const cwd = repository(context);
  const env = merge(cwd);
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
  rmSync(join(cwd, ".git"), { recursive: true });
  assert.deepEqual(proveRuntimeOmissions({ cwd, env }), { docsOnly: false, rOmittable: false });
  const output = join(cwd, "action-output");
  execFileSync(process.execPath, [script], { cwd, env: { ...process.env, ...env, GITHUB_OUTPUT: output } });
  assert.equal(readFileSync(output, "utf8"), "docs_only=false\nr_omittable=false\n");
});

test("required runtime results reject missing proof and incomplete or canceled execution", (context) => {
  assert.deepEqual(workflow.jobs["docs-proof"].outputs, {
    docs_only: "${{ steps.proof.outputs.docs_only }}",
    r_omittable: "${{ steps.proof.outputs.r_omittable }}"
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
    assert.deepEqual(job.needs, ["docs-proof", runtimeId]);
    assert.equal(job.if, "${{ always() }}", "failed or canceled dependencies must not skip required jobs");
    assert.equal(job.steps.length, 1, "required result jobs must not retain expensive work after cancellation");
    const [guard] = job.steps;
    assert.equal(guard.if, undefined);
    assert.equal(guard.shell, "bash");
    assert.equal(guard.env.PROOF_RESULT, "${{ needs.docs-proof.result }}");
    const omissionOutput = id === "r" ? "r_omittable" : "docs_only";
    const omissionEnvironment = id === "r" ? "R_OMITTABLE" : "DOCS_ONLY";
    assert.equal(guard.env[omissionEnvironment], `\${{ needs.docs-proof.outputs.${omissionOutput} }}`);
    assert.equal(guard.env[id === "r" ? "DOCS_ONLY" : "R_OMITTABLE"], undefined);
    assert.equal(guard.env.RUNTIME_RESULT, `\${{ needs.${runtimeId}.result }}`);
    assert.equal(runtime.needs, "docs-proof");
    assert.equal(
      runtime.if,
      `\${{ !cancelled() && needs.docs-proof.result == 'success' && needs.docs-proof.outputs.${omissionOutput} == 'false' }}`,
      "execution jobs must be cancellable, including while queued after a successful proof"
    );
    assert.equal(runtime["runs-on"], id === "windows" ? "windows-latest" : "ubuntu-24.04");
    assert.equal(runtime.steps[0].if, undefined);
    assert.equal(runtime.steps.at(-1).if, undefined);
    for (const [result, docsOnly, runtimeResult, expectedStatus] of [
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
      ["success", "true\nfalse", "success", 1]
    ]) {
      const summary = join(temp, "summary");
      rmSync(summary, { force: true });
      const execution = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", guard.run], {
        env: {
          ...process.env,
          PROOF_RESULT: result,
          DOCS_ONLY: id === "r" ? (docsOnly === "true" ? "false" : "true") : docsOnly,
          R_OMITTABLE: id === "r" ? docsOnly : docsOnly === "true" ? "false" : "true",
          RUNTIME_RESULT: runtimeResult,
          GITHUB_STEP_SUMMARY: summary
        },
        encoding: "utf8"
      });
      assert.equal(execution.error, undefined);
      assert.equal(execution.status, expectedStatus, `${id}: ${result}/${JSON.stringify(docsOnly)}/${runtimeResult}`);
      if (expectedStatus === 0 && docsOnly === "true") {
        assert.match(
          readFileSync(summary, "utf8"),
          id === "r"
            ? /Native R checks omitted:.*No fresh R execution is claimed/u
            : /existing regular Markdown documentation/u
        );
      }
    }
  }
});
