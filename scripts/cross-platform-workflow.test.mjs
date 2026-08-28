import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load as parseYaml } from "js-yaml";

const workflowSource = readFileSync(".github/workflows/cross-platform.yml", "utf8");
const workflow = parseYaml(workflowSource);
const dependencyAuthority = JSON.parse(readFileSync("python/runtime-dependencies.json", "utf8"));
const PROFILE_PROBE =
  "python -m pytest python/tests/test_runtime_dependency_authority.py::test_cross_platform_dependency_profile -q";

function normalizedCommand(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
}

function steps(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function stepRunning(job, command) {
  const matches = steps(job).filter((step) => normalizedCommand(step?.run) === command);
  assert.equal(matches.length, 1, `expected exactly one step running: ${command}`);
  return matches[0];
}

function stepContaining(job, fragment) {
  const matches = steps(job).filter((step) => normalizedCommand(step?.run).includes(fragment));
  assert.equal(matches.length, 1, `expected exactly one step containing: ${fragment}`);
  return matches[0];
}

function stepUsing(job, action) {
  const matches = steps(job).filter((step) => step?.uses?.startsWith(action));
  assert.equal(matches.length, 1, `expected exactly one step using: ${action}`);
  return matches[0];
}

function jobRunning(command) {
  const matches = Object.values(workflow.jobs).filter((job) =>
    steps(job).some((step) => normalizedCommand(step?.run) === command)
  );
  assert.equal(matches.length, 1, `expected exactly one job running: ${command}`);
  return matches[0];
}

function matrixRows(job) {
  const include = job?.strategy?.matrix?.include;
  assert.ok(Array.isArray(include), "expected an explicit matrix include list");
  return include;
}

function expandedJobCount(job) {
  const matrix = job?.strategy?.matrix;
  if (matrix === undefined) {
    return 1;
  }
  if (Array.isArray(matrix.include)) {
    return matrix.include.length;
  }
  const axes = Object.entries(matrix).filter(([key, value]) => key !== "exclude" && Array.isArray(value));
  return axes.reduce((count, [, values]) => count * values.length, 1);
}

function assertQualifiedPythonCoverage(authority, profiles) {
  const exactProfiles = profiles
    .filter((profile) => profile.mode === "exact")
    .map((profile) => ({
      python: profile.python,
      requirements: new Set(profile.requirements.split(" ").filter((requirement) => requirement.length > 0))
    }));
  for (const dependency of authority.dependencies) {
    const qualifiedCases = [...dependency.qualification.qualifiedCases];
    if (dependency.pythonCompatibility !== undefined) {
      qualifiedCases.push(dependency.pythonCompatibility.qualifiedCase);
    }
    for (const qualified of qualifiedCases) {
      const requirement = `${dependency.distribution}==${qualified.version}`;
      assert.ok(
        exactProfiles.some(
          (profile) => profile.python === qualified.pythonVersion && profile.requirements.has(requirement)
        ),
        `${requirement} must run on its declared Python ${qualified.pythonVersion}`
      );
    }
  }
}

test("Cross runs only on its weekly schedule or a manual request", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.equal(workflow.on.schedule[0].cron, "17 4 * * 1");
});

test("Cross keeps real macOS and Windows runtime checks", () => {
  const runtime = jobRunning("python -m pytest python/tests -q");
  const rows = matrixRows(runtime);
  assert.ok(rows.some((row) => row.os === "macos-latest" && row.python === "3.12"));
  assert.ok(rows.some((row) => row.os === "windows-latest" && row.python === "3.14"));
  assert.equal(stepUsing(runtime, "actions/setup-python@").with["python-version"], "${{ matrix.python }}");
  stepRunning(runtime, "npm run build");
  stepRunning(runtime, "npm run build:test-extension");
  assert.deepEqual(stepRunning(runtime, "node scripts/run-extension-tests.mjs platform-smoke").env, {
    VSCODE_TEST_VERSION: "stable"
  });
  assert.equal(
    steps(runtime).some((step) => normalizedCommand(step?.run) === "npm run test:extension-host"),
    false,
    "Cross must not duplicate the complete product UI journey"
  );
  assert.equal(stepRunning(runtime, "npm run test:scripts:native").if, "${{ runner.os == 'Windows' }}");
  stepContaining(runtime, "python -m pip list --format=freeze");
});

test("Cross checks the Windows dependency guard across the supported Python boundary", () => {
  const guard = jobRunning("python -m pytest python/tests/test_dependency_guard.py -q");
  assert.equal(guard["runs-on"], "windows-latest");
  assert.ok(guard.strategy.matrix.python.includes("3.10"));
  assert.ok(guard.strategy.matrix.python.includes("3.12"));

  const runtime = jobRunning("python -m pytest python/tests -q");
  assert.ok(
    matrixRows(runtime).some((row) => row.os === "windows-latest" && row.python === "3.14"),
    "the latest Python line must also run the complete Windows runtime suite"
  );
});

test("four coherent Python environments cover every qualified dependency version", () => {
  const compatibility = jobRunning(PROFILE_PROBE);
  assert.equal(compatibility["runs-on"], "ubuntu-24.04");
  const profiles = matrixRows(compatibility);
  assert.equal(profiles.length, 4);

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  assert.equal(byId.get("minimum-supported")?.python, "3.10");
  assert.equal(byId.get("pinned-known-good")?.python, "3.12");
  assert.equal(byId.get("latest-supported")?.python, "3.14");
  assert.equal(byId.get("notebook-backend-boundary")?.python, "3.12");

  const latest = byId.get("latest-supported");
  assert.equal(latest?.mode, "latest");
  assert.equal(latest?.requirements, "");
  assert.equal(latest?.pip_options, "--upgrade --upgrade-strategy eager");
  for (const profile of profiles.filter((entry) => entry.id !== "latest-supported")) {
    assert.equal(profile.mode, "exact");
    assert.equal(profile.pip_options, "");
    const requirements = profile.requirements.split(" ");
    assert.equal(requirements.length, dependencyAuthority.dependencies.length);
    for (const dependency of dependencyAuthority.dependencies) {
      assert.equal(
        requirements.filter((requirement) => requirement.startsWith(`${dependency.distribution}==`)).length,
        1,
        `${profile.id} must select ${dependency.distribution} exactly once`
      );
    }
  }

  const expectedQualifiedRequirements = new Set();
  for (const dependency of dependencyAuthority.dependencies) {
    for (const qualified of dependency.qualification.qualifiedCases) {
      const requirement = `${dependency.distribution}==${qualified.version}`;
      expectedQualifiedRequirements.add(requirement);
    }
    if (dependency.pythonCompatibility !== undefined) {
      const qualified = dependency.pythonCompatibility.qualifiedCase;
      const requirement = `${dependency.distribution}==${qualified.version}`;
      expectedQualifiedRequirements.add(requirement);
    }
  }
  assertQualifiedPythonCoverage(dependencyAuthority, profiles);
  const installedRequirements = new Set(
    profiles.flatMap((profile) => profile.requirements.split(" ")).filter((requirement) => requirement.length > 0)
  );
  assert.deepEqual(installedRequirements, expectedQualifiedRequirements);

  const profileStep = stepRunning(compatibility, PROFILE_PROBE);
  assert.deepEqual(profileStep.env, {
    OPENWRANGLER_DEPENDENCY_PROFILE: "${{ matrix.id }}",
    OPENWRANGLER_DEPENDENCY_MODE: "${{ matrix.mode }}",
    OPENWRANGLER_DEPENDENCY_PYTHON: "${{ matrix.python }}",
    OPENWRANGLER_DEPENDENCY_REQUIREMENTS: "${{ matrix.requirements }}"
  });
  stepContaining(compatibility, "python -m pip list --format=freeze");
  const notebook = stepContaining(compatibility, "python/tests/test_real_kernel.py");
  assert.equal(notebook.if, "${{ matrix.id == 'notebook-backend-boundary' }}");
  assert.match(normalizedCommand(notebook.run), /python\/tests\/test_notebook\.py/u);
  assert.match(normalizedCommand(notebook.run), /python\/tests\/test_kernel_agent\.py/u);
});

test("Cross rejects a qualified version moved to an uncovered Python line", () => {
  const changedAuthority = structuredClone(dependencyAuthority);
  const polars = changedAuthority.dependencies.find((dependency) => dependency.distribution === "polars");
  assert.ok(polars);
  polars.qualification.qualifiedCases[0].pythonVersion = "3.13";
  const profiles = matrixRows(jobRunning(PROFILE_PROBE));
  assert.throws(
    () => assertQualifiedPythonCoverage(changedAuthority, profiles),
    /polars==1\.35\.2 must run on its declared Python 3\.13/u
  );
});

test("Cross runs lock-backed R 4.4 and current R without duplicating workflows", () => {
  const r = jobRunning("npm run test:r-contract");
  const rows = matrixRows(r);
  assert.ok(rows.some((row) => row.version === "4.4.3" && row.lock.endsWith("ubuntu-24.04-x86_64-r-4.4.lock.json")));
  assert.ok(rows.some((row) => row.version === "4.5.3" && row.lock.endsWith("ubuntu-24.04-x86_64-r-4.5.lock.json")));
  assert.equal(stepUsing(r, "r-lib/actions/setup-r@").with["r-version"], "${{ matrix.version }}");
  stepRunning(r, "Rscript --version");
  const lockCommands = steps(r)
    .map((step) => normalizedCommand(step?.run))
    .filter((command) => command.includes("scripts/r-dependency-lock.mjs"));
  assert.equal(lockCommands.length, 2);
  assert.ok(lockCommands.every((command) => command.includes('--lock "${{ matrix.lock }}"')));
});

test("Cross stays within a ten-job and 280-runner-minute ceiling", () => {
  const jobs = Object.values(workflow.jobs);
  const expandedJobs = jobs.reduce((count, job) => count + expandedJobCount(job), 0);
  const timeoutBudget = jobs.reduce((minutes, job) => minutes + expandedJobCount(job) * job["timeout-minutes"], 0);
  assert.ok(expandedJobs <= 10, `Cross expands to ${expandedJobs} jobs`);
  assert.ok(timeoutBudget <= 280, `Cross reserves up to ${timeoutBudget} runner minutes`);
  assert.doesNotMatch(workflowSource, /Exact Python dependency/u);
});
