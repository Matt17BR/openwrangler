import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectCandidateAcceptanceWorkflow, inspectCandidateCaller } from "./candidate-acceptance-workflow.mjs";
import { NATIVE_R_CANDIDATE_CACHE_VERSION, NATIVE_R_CANDIDATE_PACKAGE_SPECS } from "./r-dependency-lock.mjs";

const source = readFileSync(new URL("../.github/workflows/candidate-acceptance.yml", import.meta.url), "utf8");

function workflow() {
  return structuredClone(parseYaml(source));
}

function inspectMutation(mutate) {
  const document = workflow();
  mutate(document);
  return inspectCandidateAcceptanceWorkflow(dumpYaml(document, { lineWidth: 120 }));
}

function expectRejected(mutate, pattern) {
  const problems = inspectMutation(mutate);
  assert.ok(problems.length > 0, "The mutated workflow must be rejected.");
  if (pattern !== undefined) assert.match(problems.join("\n"), pattern);
}

function step(job, predicate) {
  return job.steps.find(predicate);
}

test("accepts the fixed parallel candidate acceptance topology", () => {
  assert.deepEqual(inspectCandidateAcceptanceWorkflow(source), []);
});

test("released Python Jupyter uses the fixed candidate one-owner profile", () => {
  const value = workflow();
  const runner = step(value.jobs.jupyter, (entry) => entry.id === "packaged_editor");
  assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE, "candidate-one-owner");
  expectRejected((mutated) => {
    delete step(mutated.jobs.jupyter, (entry) => entry.id === "packaged_editor").env
      .OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE;
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((mutated) => {
    step(
      mutated.jobs.jupyter,
      (entry) => entry.id === "packaged_editor"
    ).env.OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE = "other";
  }, /verifier.*packaged phase.*upload/u);
});

test("rejects invalid or oversized workflow text", () => {
  assert.match(inspectCandidateAcceptanceWorkflow("not: [yaml")[0], /valid YAML/u);
  assert.match(inspectCandidateAcceptanceWorkflow("x".repeat(2 * 1024 * 1024 + 1))[0], /bounded YAML/u);
});

test("requires exactly three inputs, three performance outputs, and eight fixed jobs", () => {
  expectRejected((value) => {
    delete value.on.workflow_call.outputs.performance_sha256;
  }, /three required inputs, three bounded performance outputs/u);
  expectRejected((value) => {
    value.on.workflow_call.inputs.lane = { required: true, type: "string" };
  }, /three required inputs/u);
  expectRejected((value) => {
    delete value.jobs.acceptance;
  }, /eight fixed jobs/u);
});

test("input contract rejects malformed artifact IDs, SHAs, and channels before fan-out", () => {
  expectRejected((value) => {
    value.jobs.contract.steps[0].run = "true";
  }, /fail closed/u);
  expectRejected((value) => {
    value.jobs.contract.steps[0].env.EXTRA = "unsafe";
  }, /fail closed/u);
});

test("platform owns the exact two-cell macOS and Windows matrix", () => {
  expectRejected((value) => {
    value.jobs.platform.strategy["fail-fast"] = true;
  }, /macOS and Windows matrix/u);
  expectRejected((value) => {
    value.jobs.platform.strategy["max-parallel"] = 1;
  }, /macOS and Windows matrix/u);
  expectRejected((value) => {
    value.jobs.platform.strategy.matrix.include[1].python = "3.12";
  }, /macOS and Windows matrix/u);
  expectRejected((value) => {
    value.jobs.platform["runs-on"] = "ubuntu-24.04";
  }, /fixed runner|macOS and Windows/u);
});

test("generic platform cells use one VS Code smoke and leave fork compatibility to Linux", () => {
  const value = workflow();
  assert.equal(
    step(value.jobs.platform, (entry) => entry.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_MODE,
    "platform-smoke"
  );
  assert.equal(
    value.jobs.platform.steps.some((entry) => entry?.env?.OPEN_WRANGLER_PACKAGED_EDITORS?.includes("cursor")),
    false
  );
  expectRejected((mutated) => {
    delete step(mutated.jobs.platform, (entry) => entry.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_MODE;
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((mutated) => {
    step(mutated.jobs.platform, (entry) => entry.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_MODE = "full";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((mutated) => {
    mutated.jobs.platform.steps.push({
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix",
      env: { OPEN_WRANGLER_PACKAGED_EDITORS: "cursor", OPEN_WRANGLER_PACKAGED_MODE: "platform-smoke" }
    });
  }, /single pinned Linux Cursor smoke seam/u);
});

test("generic platform acceptance contains no hosted-R setup or R-Jupyter tail", () => {
  expectRejected((value) => {
    value.jobs.platform.steps.push({
      uses: "r-lib/actions/setup-r@d3c5be51b12e724e68f33216ca3c148b66d5f0b6",
      with: { "r-version": "4.5.2", "use-public-rspm": true }
    });
  }, /must stay generic/u);
  expectRejected((value) => {
    value.jobs.platform.steps.push({
      id: "packaged_editor_r_platform",
      env: { OPEN_WRANGLER_PACKAGED_MODE: "r-jupyter" },
      run: "node scripts/run-packaged-editor-tests.mjs canonical-release/openwrangler.vsix"
    });
  }, /must stay generic/u);
});

test("generic platform acceptance does not rerun pull-request source or harness suites", () => {
  for (const run of ["npm run test:python-environment-smoke", "npm run test:extension-host"]) {
    expectRejected((value) => {
      value.jobs.platform.steps.push({ run });
    }, /artifact-focused.*source or harness suites/u);
  }
});

test("r_platform owns one R 4.4 compatibility row and the R 4.5 platform rows", () => {
  expectRejected((value) => {
    value.jobs.r_platform.strategy["fail-fast"] = true;
  }, /R 4\.4 compatibility and R 4\.5 platform matrix/u);
  expectRejected((value) => {
    value.jobs.r_platform.strategy["max-parallel"] = 1;
  }, /R 4\.4 compatibility and R 4\.5 platform matrix/u);
  expectRejected((value) => {
    value.jobs.r_platform.strategy.matrix.include[0].python = "3.14";
  }, /R 4\.4 compatibility and R 4\.5 platform matrix/u);
  expectRejected((value) => {
    value.jobs.r_platform.strategy.matrix.include[0].r = "4.5.2";
  }, /R 4\.4 compatibility and R 4\.5 platform matrix/u);
  expectRejected((value) => {
    value.jobs.r_platform["runs-on"] = "ubuntu-24.04";
  }, /fixed runner|R 4\.4 compatibility/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "rscript").shell = "bash";
  }, /R 4\.4 compatibility and R 4\.5 platform matrix/u);
});

test("r_platform uses exact focused selectors in one VS Code runner per operating system", () => {
  for (const [id, journey] of [
    ["packaged_editor_r_core", "core-operations"],
    ["packaged_editor_r_native", "native-frames"],
    ["packaged_editor_r_restart", "kernel-restart"]
  ]) {
    const value = workflow();
    const runner = step(value.jobs.r_platform, (entry) => entry.id === id);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY, journey);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  }
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "packaged_editor_r_native").env[
      "OPEN_WRANGLER_PACKAGED_R_JOURNEY"
    ] = "core-operations";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "packaged_editor_r_restart").env[
      "OPEN_WRANGLER_PACKAGED_EDITORS"
    ] = "vscode,cursor";
  }, /verifier.*packaged phase.*upload/u);
});

test("every r_platform phase has an independent verifier and unique immediate failure upload", () => {
  expectRejected((value) => {
    value.jobs.r_platform.steps = value.jobs.r_platform.steps.filter((entry) => entry.id !== "r_platform_setup");
  }, /shared setup boundary/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "r_platform_setup").shell = "pwsh";
  }, /shared setup boundary/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "canonical_r_native").if =
      "${{ always() && steps.packaged_editor_r_core.outcome == 'success' }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.id === "packaged_editor_r_restart")["continue-on-error"] = false;
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    const steps = value.jobs.r_platform.steps;
    const runner = steps.findIndex((entry) => entry.id === "packaged_editor_r_native");
    steps.splice(runner, 0, { run: "true" });
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.name === "Upload platform native R frame failure diagnostics").with[
      "name"
    ] = "${{ inputs.channel }}-release-r-jupyter-platform-core-${{ runner.os }}-${{ github.run_attempt }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.name === "Upload platform R kernel restart failure diagnostics").if =
      "${{ success() }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    value.jobs.r_platform.steps.splice(-1, 0, { id: "rogue", "continue-on-error": true, run: "true" });
  }, /bounded order/u);
});

test("r_platform orders all phases and defers one literal three-outcome verdict", () => {
  expectRejected((value) => {
    const steps = value.jobs.r_platform.steps;
    const nativeVerifier = steps.findIndex((entry) => entry.id === "canonical_r_native");
    const nativeTriple = steps.splice(nativeVerifier, 3);
    steps.splice(steps.findIndex((entry) => entry.id === "canonical_r_restart") + 3, 0, ...nativeTriple);
  }, /bounded order|verifier.*packaged phase/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.name === "Require successful platform R outcomes").if =
      "${{ success() }}";
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    step(value.jobs.r_platform, (entry) => entry.name === "Require successful platform R outcomes").shell = "pwsh";
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const verdict = step(value.jobs.r_platform, (entry) => entry.name === "Require successful platform R outcomes");
    verdict.run = verdict.run.replace('test "$NATIVE_OUTCOME" = "success"', "true");
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const verdict = step(value.jobs.r_platform, (entry) => entry.name === "Require successful platform R outcomes");
    verdict.env.RESTART_OUTCOME = "${{ steps.packaged_editor_r_core.outcome }}";
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const steps = value.jobs.r_platform.steps;
    const upload = steps.findIndex((entry) => entry.name === "Upload platform R core failure diagnostics");
    steps.splice(upload + 1, 0, {
      name: "Fail after platform R core diagnostics",
      if: "${{ always() && steps.packaged_editor_r_core.outcome == 'failure' }}",
      run: "exit 1"
    });
  }, /literal raw-outcome verdict/u);
});

test("linux and performance remain fixed parallel siblings", () => {
  expectRejected((value) => {
    value.jobs.linux.needs = ["contract", "platform"];
  }, /fixed runner and direct dependency/u);
  expectRejected((value) => {
    value.jobs.performance["runs-on"] = "${{ inputs.runner_os }}";
  }, /fixed runner and direct dependency/u);
  expectRejected((value) => {
    step(value.jobs.linux, (entry) => entry.run === "npm run benchmark:runtime").run = "true";
  }, /canonical artifact verification, live repository metadata, audits, quick benchmark/u);
  expectRejected((value) => {
    step(value.jobs.linux, (entry) => entry.run === "npm run repository:check-live").run = "true";
  }, /canonical artifact verification, live repository metadata, audits, quick benchmark/u);
});

test("performance prepares one authoritative remote tar-inspection interpreter before pinned editor acquisition", () => {
  const value = workflow();
  const setup = step(value.jobs.performance, (entry) => entry.id === "inspection_python");
  const runner = step(value.jobs.performance, (entry) => entry.id === "installed_performance");
  assert.equal(runner.env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON, "${{ steps.inspection_python.outputs.python-path }}");
  assert.ok(value.jobs.performance.steps.indexOf(setup) < value.jobs.performance.steps.indexOf(runner));

  expectRejected((mutated) => {
    delete step(mutated.jobs.performance, (entry) => entry.id === "installed_performance").env
      .OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON;
  }, /remote tar inspector.*PATH fallbacks/u);
  expectRejected((mutated) => {
    step(
      mutated.jobs.performance,
      (entry) => entry.id === "installed_performance"
    ).env.OPEN_WRANGLER_REMOTE_INSPECTION_PYTHON = "python3";
  }, /remote tar inspector.*PATH fallbacks/u);
  expectRejected((mutated) => {
    step(mutated.jobs.performance, (entry) => entry.id === "inspection_python").uses = "actions/setup-python@v6";
  }, /pinned setup-python.*remote tar inspector/u);
  expectRejected((mutated) => {
    const steps = mutated.jobs.performance.steps;
    const setupIndex = steps.findIndex((entry) => entry.id === "inspection_python");
    const [lateSetup] = steps.splice(setupIndex, 1);
    const runnerIndex = steps.findIndex((entry) => entry.id === "installed_performance");
    steps.splice(runnerIndex + 1, 0, lateSetup);
  }, /before editor acquisition/u);
  expectRejected((mutated) => {
    const setupIndex = mutated.jobs.performance.steps.findIndex((entry) => entry.id === "inspection_python");
    mutated.jobs.performance.steps.splice(setupIndex + 1, 0, {
      uses: "actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1",
      with: { "python-version": "3.12", cache: "pip" }
    });
  }, /one pinned setup-python/u);
});

test("performance publishes one digest-bound VS Code report to the caller", () => {
  const value = workflow();
  assert.equal(value.jobs.performance.outputs["artifact-id"], "${{ steps.performance_artifact.outputs.artifact-id }}");
  expectRejected((mutated) => {
    mutated.jobs.performance.steps.find((entry) => entry.id === "performance_artifact").with.name = "other";
  }, /digest-bound successful report/u);
  expectRejected((mutated) => {
    mutated.jobs.performance.steps.find((entry) => entry.id === "performance_report").run = "true";
  }, /digest-bound successful report/u);
});

test("linux acceptance does not rerun pull-request suites or their private setup", () => {
  const value = workflow();
  assert.equal(
    value.jobs.linux.steps.some((entry) => entry.uses?.startsWith("actions/setup-java@")),
    false
  );
  for (const run of [
    "npm run check",
    "npm run test:scripts",
    "npm run test:webview-acceptance",
    "npm run test:coverage",
    "npx --no-install playwright-core install --with-deps chromium",
    'python -m pip install "pandas>=2.2,<3.0" "pyspark[connect]==4.2.0"',
    'python -m pip install --no-deps "https://files.pythonhosted.org/packages/uv-0.11.32-py3-none-manylinux.whl"'
  ]) {
    expectRejected((value) => {
      value.jobs.linux.steps.push({ run });
    }, /artifact-focused.*source suites, harness setup/u);
  }
  expectRejected((value) => {
    value.jobs.linux.steps.push({ name: "Verify exact coverage runtimes", run: "true" });
  }, /artifact-focused.*source suites, harness setup/u);
  expectRejected((mutated) => {
    mutated.jobs.linux.steps.splice(3, 0, {
      uses: "actions/setup-java@f2beeb24e141e01a676f977032f5a29d81c9e27e",
      with: { distribution: "temurin", "java-version": "17" }
    });
  }, /artifact-focused.*Jupyter-owned Java/u);
});

test("Linux VS Code is the sole full generic owner and Cursor is a pinned compatibility seam", () => {
  const value = workflow();
  const vscode = step(value.jobs.linux, (entry) => entry.id === "packaged_vscode");
  const cursor = step(value.jobs.linux, (entry) => entry.id === "packaged_cursor");
  const cursorIndex = value.jobs.linux.steps.indexOf(cursor);
  assert.equal(vscode.env.OPEN_WRANGLER_PACKAGED_MODE, undefined);
  assert.equal(cursor.env.OPEN_WRANGLER_PACKAGED_MODE, "platform-smoke");
  assert.equal(cursor.name, "Test the pinned Cursor compatibility smoke seam");
  assert.equal(value.jobs.linux.steps[cursorIndex + 1].name, "Upload pinned Cursor compatibility failure diagnostics");
  assert.equal(value.jobs.linux.steps[cursorIndex + 2].name, "Fail after pinned Cursor compatibility diagnostics");
  expectRejected((mutated) => {
    delete step(mutated.jobs.linux, (entry) => entry.id === "packaged_cursor").env.OPEN_WRANGLER_PACKAGED_MODE;
  }, /sole full generic editor owner.*every other generic editor consumer.*platform-smoke/u);
  expectRejected((mutated) => {
    step(mutated.jobs.linux, (entry) => entry.id === "packaged_cursor").env.OPEN_WRANGLER_PACKAGED_MODE = "full";
  }, /sole full generic editor owner.*every other generic editor consumer.*platform-smoke/u);
  expectRejected((mutated) => {
    step(mutated.jobs.linux, (entry) => entry.id === "packaged_vscode").env.OPEN_WRANGLER_PACKAGED_MODE =
      "platform-smoke";
  }, /sole full generic editor owner/u);
  expectRejected((mutated) => {
    step(mutated.jobs.linux, (entry) => entry.id === "packaged_cursor").name =
      "Test the full package in private-display Cursor";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((mutated) => {
    step(mutated.jobs.linux, (entry) => entry.name === "Upload pinned Cursor compatibility failure diagnostics").name =
      "Upload Cursor failure diagnostics";
  }, /verifier.*packaged phase.*upload/u);
});

test("Cursor runs exactly one lifecycle seam and never owns operation, Jupyter, or performance semantics", () => {
  const value = workflow();
  const cursorSteps = Object.values(value.jobs).flatMap((job) =>
    (job.steps ?? []).filter((entry) => String(entry?.env?.OPEN_WRANGLER_PACKAGED_EDITORS ?? "").includes("cursor"))
  );
  assert.deepEqual(
    cursorSteps.map((entry) => entry.id),
    ["packaged_cursor"]
  );
  expectRejected((mutated) => {
    step(mutated.jobs.jupyter, (entry) => entry.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_EDITORS =
      "vscode,cursor";
  }, /exactly one pinned Cursor lifecycle seam/u);
});

test("candidate consumers rely on canonical reverification without repeating full VSIX verification", () => {
  const value = workflow();
  assert.equal(
    Object.values(value.jobs).some((job) =>
      job.steps.some((entry) => entry.run === "npm run verify:vsix -- canonical-release/openwrangler.vsix")
    ),
    false
  );
  for (const [jobName, job] of Object.entries(value.jobs)) {
    for (const [index, runner] of job.steps.entries()) {
      if (!runner.id?.startsWith("packaged_")) continue;
      assert.match(job.steps[index - 1]?.id ?? "", /^canonical/u, `${jobName}/${runner.id} must retain its verifier.`);
    }
  }
  for (const jobName of ["platform", "r_platform", "linux", "jupyter", "r_local"]) {
    expectRejected((mutated) => {
      mutated.jobs[jobName].steps.push({ run: "npm run verify:vsix -- canonical-release/openwrangler.vsix" });
    }, /canonical checksum\/provenance verifier.*producer-owned full VSIX verification/u);
  }
});

test("jupyter contains only independent Python and remote-R cells", () => {
  expectRejected((value) => {
    value.jobs.jupyter.strategy.matrix.phase = ["python", "r-local", "r-remote"];
  }, /only independent Python and remote-R/u);
  expectRejected((value) => {
    value.jobs.jupyter.strategy["fail-fast"] = true;
  }, /only independent Python and remote-R/u);
  expectRejected((value) => {
    value.jobs.jupyter.steps.push({ run: "npm run test:r-contract" });
  }, /local R belongs to its shards/u);
});

test("jupyter consumes the producer-validated remote lock without rebuilding its proof", () => {
  const value = workflow();
  for (const duplicate of [
    "npm run lock:remote-jupyter:check",
    "npm run audit:remote-jupyter",
    "uv-0.11.32-py3-none-manylinux"
  ]) {
    assert.equal(
      value.jobs.jupyter.steps.some((entry) => entry.run?.includes(duplicate)),
      false,
      `${duplicate} must remain producer-owned.`
    );
    expectRejected((mutated) => {
      mutated.jobs.jupyter.steps.push({
        run: duplicate === "uv-0.11.32-py3-none-manylinux" ? `python -m pip install ${duplicate}` : duplicate,
        if: "${{ matrix.phase == 'python' }}"
      });
    }, /producer-validated remote lock.*reinstalling uv.*repeating lock/u);
  }
});

test("candidate acceptance omits the protected-PR native R contract owner", () => {
  const value = workflow();
  assert.equal(value.jobs.r_contract, undefined);
  assert.equal(
    Object.values(value.jobs).some((job) => job.steps.some((entry) => entry.run === "npm run test:r-contract")),
    false
  );
  expectRejected((mutated) => {
    mutated.jobs.r_contract = {
      name: "Native R contract",
      needs: "contract",
      "runs-on": "ubuntu-24.04",
      "timeout-minutes": 30,
      steps: [{ run: "npm run test:r-contract" }]
    };
  }, /must not reintroduce.*source-only native R contract.*protected PR CI/u);
  expectRejected((mutated) => {
    mutated.jobs.performance.steps.push({ run: "npm run test:r-contract" });
  }, /must not reintroduce.*source-only native R contract.*protected PR CI/u);
});

test("r_local consumes the categorized Native R package authority and versioned cache", () => {
  const value = workflow();
  const dependency = step(value.jobs.r_local, (entry) => entry.name === "Resolve local R packages");
  assert.deepEqual(dependency.with["extra-packages"].split("\n"), NATIVE_R_CANDIDATE_PACKAGE_SPECS);
  assert.equal(dependency.with["cache-version"], NATIVE_R_CANDIDATE_CACHE_VERSION);
  assert.equal(NATIVE_R_CANDIDATE_PACKAGE_SPECS.filter((spec) => spec === "any::rlang").length, 1);
  assert.equal(NATIVE_R_CANDIDATE_PACKAGE_SPECS.at(-1), "any::collapse");

  expectRejected((mutated) => {
    step(mutated.jobs.r_local, (entry) => entry.name === "Resolve local R packages").with["extra-packages"] =
      NATIVE_R_CANDIDATE_PACKAGE_SPECS.filter((spec) => spec !== "any::rlang").join("\n");
  }, /exact hosted R 4\.5\.2 package contract/u);
  expectRejected((mutated) => {
    step(mutated.jobs.r_local, (entry) => entry.name === "Resolve local R packages").with["extra-packages"] =
      NATIVE_R_CANDIDATE_PACKAGE_SPECS.filter((spec) => spec !== "any::collapse").join("\n");
  }, /exact hosted R 4\.5\.2 package contract/u);
  expectRejected((mutated) => {
    const packages = [...NATIVE_R_CANDIDATE_PACKAGE_SPECS];
    packages.splice(packages.indexOf("any::rlang"), 1);
    packages.push("any::rlang");
    step(mutated.jobs.r_local, (entry) => entry.name === "Resolve local R packages").with["extra-packages"] =
      packages.join("\n");
  }, /exact hosted R 4\.5\.2 package contract/u);
  expectRejected((mutated) => {
    step(mutated.jobs.r_local, (entry) => entry.name === "Resolve local R packages").with["cache-version"] =
      "native-r-contract-v1";
  }, /exact hosted R 4\.5\.2 package contract/u);
});

test("r_local remains a direct artifact-backed sibling of the other candidate lanes", () => {
  expectRejected((value) => {
    value.jobs.r_local.needs = ["contract", "jupyter"];
  }, /fixed runner|shards backed by the artifact/u);
  expectRejected((value) => {
    value.jobs.r_local.steps.push({
      run: "npm run test:r-contract"
    });
  }, /must not reintroduce.*native R contract/u);
});

test("r_local uses exactly two balanced, non-cancelling shards", () => {
  expectRejected((value) => {
    value.jobs.r_local.strategy.matrix.shard = ["core", "value", "categorical", "interactive", "literate"];
  }, /two non-cancelling balanced shards/u);
  expectRejected((value) => {
    value.jobs.r_local.strategy["fail-fast"] = true;
  }, /two non-cancelling balanced shards/u);
  expectRejected((value) => {
    value.jobs.r_local.strategy["max-parallel"] = 1;
  }, /two non-cancelling balanced shards/u);
});

test("every local phase uses its explicit selector and exact editor ownership", () => {
  for (const [id, journey, editors] of [
    ["packaged_editor_r_core", "core-operations", "vscode"],
    ["packaged_editor_r_restart", "kernel-restart", "vscode"],
    ["packaged_editor_r_interactive", "interactive-terminal", "vscode"],
    ["packaged_editor_r_literate", "literate-documents", "vscode"],
    ["packaged_editor_r_native", "native-frames", "vscode"],
    ["packaged_editor_r_values", "value-operations", "vscode"],
    ["packaged_editor_r_categorical", "categorical-operations", "vscode"]
  ]) {
    const value = workflow();
    const runner = step(value.jobs.r_local, (entry) => entry.id === id);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY, journey);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_EDITORS, editors);
  }
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.id === "packaged_editor_r_core").env.OPEN_WRANGLER_PACKAGED_R_JOURNEY =
      "value-operations";
  }, /verifier.*packaged phase.*upload/u);
  for (const id of ["packaged_editor_r_core", "packaged_editor_r_values", "packaged_editor_r_categorical"]) {
    expectRejected((value) => {
      step(value.jobs.r_local, (entry) => entry.id === id).env.OPEN_WRANGLER_PACKAGED_EDITORS = "vscode,cursor";
    }, /verifier.*packaged phase.*upload/u);
  }
});

test("every local phase has an adjacent verifier and immediate exact failure upload", () => {
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.id === "canonical_r_restart").if =
      "${{ always() && steps.packaged_editor_r_core.outcome == 'success' }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.id === "packaged_editor_r_restart")["continue-on-error"] = false;
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    const steps = value.jobs.r_local.steps;
    const runner = steps.findIndex((entry) => entry.id === "packaged_editor_r_interactive");
    steps.splice(runner, 0, { run: "true" });
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    const upload = step(value.jobs.r_local, (entry) => entry.name === "Upload R kernel restart failure diagnostics");
    upload.with.name = "${{ inputs.channel }}-release-r-jupyter-local-${{ runner.os }}-${{ github.run_attempt }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    const upload = step(value.jobs.r_local, (entry) => entry.name === "Upload value R-Jupyter failure diagnostics");
    upload.with.path = "tmp/**";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    const upload = step(
      value.jobs.r_local,
      (entry) => entry.name === "Upload categorical R-Jupyter failure diagnostics"
    );
    upload.if = "${{ always() }}";
  }, /verifier.*packaged phase.*upload/u);
  expectRejected((value) => {
    value.jobs.r_local.steps.splice(-1, 0, { id: "rogue", "continue-on-error": true, run: "true" });
  }, /balanced shard order/u);
});

test("local shard order is lifecycle then editing with one deferred raw-outcome verdict", () => {
  expectRejected((value) => {
    const steps = value.jobs.r_local.steps;
    const valueIndex = steps.findIndex((entry) => entry.id === "packaged_editor_r_values");
    const [runner] = steps.splice(valueIndex, 1);
    steps.splice(
      steps.findIndex((entry) => entry.id === "packaged_editor_r_interactive"),
      0,
      runner
    );
  }, /balanced shard order|verifier.*packaged phase/u);
  expectRejected((value) => {
    const steps = value.jobs.r_local.steps;
    const restartVerifier = steps.findIndex((entry) => entry.id === "canonical_r_restart");
    const restartTriple = steps.splice(restartVerifier, 3);
    steps.splice(steps.findIndex((entry) => entry.id === "canonical_r_literate") + 3, 0, ...restartTriple);
  }, /balanced shard order|verifier.*packaged phase/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes").if =
      "${{ success() }}";
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes").run =
      'test "$CORE_OUTCOME" != "failure"';
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const verdict = step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes");
    verdict.run = verdict.run.replace('test "$RESTART_OUTCOME" = "success"', "true");
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const verdict = step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes");
    verdict.run = verdict.run.replace('test "$NATIVE_OUTCOME" = "success"', "true");
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    const steps = value.jobs.r_local.steps;
    const upload = steps.findIndex((entry) => entry.name === "Upload native R frame failure diagnostics");
    steps.splice(upload + 1, 0, {
      name: "Fail after native R frame diagnostics",
      if: "${{ always() && steps.packaged_editor_r_native.outcome == 'failure' }}",
      run: "exit 1"
    });
  }, /literal raw-outcome verdict/u);
});

test("fan-in always needs every job and accepts only literal success", () => {
  expectRejected((value) => {
    value.jobs.acceptance.needs.pop();
  }, /always fan in every direct job/u);
  expectRejected((value) => {
    value.jobs.acceptance.if = "${{ success() }}";
  }, /always fan in every direct job/u);
  expectRejected((value) => {
    value.jobs.acceptance.steps[0].run = 'test "$PLATFORM_RESULT" != "failure"';
  }, /literal success result/u);
  expectRejected((value) => {
    value.jobs.acceptance.needs = value.jobs.acceptance.needs.filter((name) => name !== "r_platform");
  }, /always fan in every direct job/u);
  expectRejected((value) => {
    value.jobs.acceptance.steps[0].run = value.jobs.acceptance.steps[0].run.replace(
      'test "$R_PLATFORM_RESULT" = "success"',
      "true"
    );
  }, /literal success result/u);
});

test("all action references remain immutable and diagnostics channel-scoped", () => {
  expectRejected((value) => {
    value.jobs.r_local.steps.find((entry) => entry.uses?.startsWith("actions/download-artifact@")).uses =
      "actions/download-artifact@v8";
  }, /pinned to one full commit/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.name === "Upload local R-Jupyter failure diagnostics").with.name =
      "local-r-failure";
  }, /namespaced to the release candidate/u);
});

test("all artifact consumers use the numeric ID and never rebuild", () => {
  expectRejected((value) => {
    value.jobs.r_local.steps.find((entry) => entry.uses?.startsWith("actions/download-artifact@")).with[
      "artifact-ids"
    ] = "openwrangler-preview-release";
  }, /numeric caller-bound canonical artifact/u);
  expectRejected((value) => {
    value.jobs.jupyter.steps.push({ run: "npm run package" });
  }, /never rebuild/u);
});

test("private-display jobs retain the validated Xvfb preparation", () => {
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.id === "prepare_xvfb").run = "console.log('/usr/bin/Xvfb')";
  }, /prepare one pinned private Xvfb/u);
});

test("single-call caller contract rejects matrices, extra inputs, outputs, and wrong channels", () => {
  const caller = {
    jobs: {
      "candidate-acceptance": {
        name: "Candidate acceptance",
        needs: "package",
        uses: "./.github/workflows/candidate-acceptance.yml",
        permissions: { contents: "read" },
        with: {
          artifact_id: "${{ needs.package.outputs.artifact-id }}",
          channel: "preview",
          expected_sha: "${{ github.sha }}",
          release_tag: "${{ inputs.release_tag }}"
        }
      }
    }
  };
  assert.deepEqual(inspectCandidateCaller(caller, "preview"), []);
  for (const mutate of [
    (value) => {
      value.jobs["candidate-acceptance"].strategy = { matrix: { lane: ["linux"] } };
    },
    (value) => {
      value.jobs["candidate-acceptance"].with.lane = "linux";
    },
    (value) => {
      value.jobs["candidate-acceptance"].outputs = { accepted: "true" };
    },
    (value) => {
      value.jobs["candidate-acceptance"].with.channel = "stable";
    }
  ]) {
    const value = structuredClone(caller);
    mutate(value);
    assert.match(inspectCandidateCaller(value, "preview").join("\n"), /one read-only call/u);
  }
});
