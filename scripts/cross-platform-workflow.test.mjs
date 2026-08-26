import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as parseYaml } from "js-yaml";

const workflow = parseYaml(readFileSync(".github/workflows/cross-platform.yml", "utf8"));

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function stepRunning(job, command) {
  const matches = (job?.steps ?? []).filter((step) => normalizedCommand(step?.run) === command);
  assert.equal(matches.length, 1, `expected exactly one step running: ${command}`);
  return matches[0];
}

function stepUsing(job, action) {
  const matches = (job?.steps ?? []).filter((step) => step?.uses?.startsWith(action));
  assert.equal(matches.length, 1, `expected exactly one step using: ${action}`);
  return matches[0];
}

test("Cross runs only on its schedule or manual request", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule[0].cron, "17 4 * * 1");
});

test("Cross covers macOS, Windows, and the Windows supervisor", () => {
  const runtime = workflow.jobs.runtime;
  assert.equal(runtime["runs-on"], "${{ matrix.os }}");
  assert.deepEqual(runtime.strategy.matrix.include, [
    { os: "macos-latest", python: "3.12" },
    { os: "windows-latest", python: "3.14" }
  ]);
  assert.equal(stepUsing(runtime, "actions/setup-python@").with["python-version"], "${{ matrix.python }}");
  stepRunning(runtime, "python -m pytest python/tests -q");
  const extensionHost = stepRunning(runtime, "npm run test:extension-host");
  assert.deepEqual(extensionHost.env, { VSCODE_TEST_VERSION: "stable" });
  const native = stepRunning(runtime, "npm run test:scripts:native");
  assert.equal(native.if, "${{ runner.os == 'Windows' }}");
});

test("Cross exercises the Windows dependency guard on both supported Python lines", () => {
  const dependencyGuard = workflow.jobs["dependency-guard-windows"];
  assert.equal(dependencyGuard["runs-on"], "windows-latest");
  assert.deepEqual(dependencyGuard.strategy.matrix.python, ["3.10", "3.12"]);
  assert.equal(stepUsing(dependencyGuard, "actions/setup-python@").with["python-version"], "${{ matrix.python }}");
  stepRunning(dependencyGuard, "python -m pip install pytest");
  stepRunning(dependencyGuard, "python -m pytest python/tests/test_dependency_guard.py -q");
});

test("Cross checks R 4.4 with its declared system library", () => {
  const r = workflow.jobs["r-4-4-scheduled-qualification"];
  assert.equal(stepUsing(r, "r-lib/actions/setup-r@").with["r-version"], "4.4");
  const systemPackages = r.steps.filter((step) => normalizedCommand(step?.run).includes("libx11-dev"));
  assert.equal(systemPackages.length, 1);
  assert.match(systemPackages[0].run, /apt-get install --yes --no-install-recommends libx11-dev/u);
  assert.match(systemPackages[0].run, /dpkg-query .*libx11-dev/u);
  stepRunning(r, "npm run test:r-contract");
});

test("Cross runs every generated dependency cohort", () => {
  const cohort = workflow.jobs["python-runtime-dependency-cohorts"];
  assert.equal(cohort["runs-on"], "ubuntu-24.04");
  assert.ok(cohort.strategy.matrix.include.length > 0);
  for (const entry of cohort.strategy.matrix.include) {
    assert.equal(entry.requirement, `${entry.id}==${entry.version}`);
    assert.match(entry.python, /^3\.(?:10|12)$/u);
  }
  assert.equal(stepUsing(cohort, "actions/setup-python@").with["python-version"], "${{ matrix.python }}");
  stepRunning(cohort, 'python -m pip install -e "python[dev]" "${{ matrix.requirement }}"');
  const probe = stepRunning(
    cohort,
    "python -m pytest python/tests/test_runtime_dependency_authority.py::test_exact_qualified_dependency_probe -q"
  );
  assert.deepEqual(probe.env, {
    OPENWRANGLER_QUALIFIED_DEPENDENCY_ID: "${{ matrix.id }}",
    OPENWRANGLER_QUALIFIED_PYTHON_VERSION: "${{ matrix.python }}",
    OPENWRANGLER_QUALIFIED_DEPENDENCY_VERSION: "${{ matrix.version }}"
  });
});
