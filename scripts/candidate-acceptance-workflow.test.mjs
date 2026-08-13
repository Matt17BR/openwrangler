import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectCandidateAcceptanceWorkflow } from "./candidate-acceptance-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/candidate-acceptance.yml", import.meta.url), "utf8");
const findRDependencies = (workflow) =>
  workflow.jobs.jupyter.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r-dependencies@"));

test("candidate acceptance shares one fail-closed artifact contract across release channels", () => {
  assert.deepEqual(inspectCandidateAcceptanceWorkflow(source), []);

  const mutate = (change) => {
    const workflow = parseYaml(source);
    change(workflow);
    return dumpYaml(workflow);
  };
  const cases = [
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.jobs.contract.steps[0].run = workflow.jobs.contract.steps[0].run.replace(
        "jupyter:ubuntu-24.04:3.12",
        "jupyter:ubuntu-24.04:3.13"
      );
    },
    (workflow) => {
      const step = workflow.jobs.contract.steps[0];
      step.env.RUNNER_OS = step.env.CANDIDATE_RUNNER_OS;
      delete step.env.CANDIDATE_RUNNER_OS;
      step.run = step.run.replaceAll("CANDIDATE_RUNNER_OS", "RUNNER_OS");
    },
    (workflow) => {
      workflow.jobs.platform["timeout-minutes"] = 240;
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@")).with.ref =
        "main";
    },
    (workflow) => {
      workflow.jobs.performance.steps.find((step) =>
        String(step.uses ?? "").startsWith("actions/download-artifact@")
      ).with["artifact-ids"] = "openwrangler-release";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.id === "canonical").env.EXPECTED_SHA = "${{ github.sha }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.strategy["fail-fast"] = true;
    },
    (workflow) => {
      workflow.jobs.jupyter.strategy.matrix.phase = ["python"];
    },
    (workflow) => {
      workflow.jobs.jupyter.container = "rocker/r-ver:4.5.2";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r@")).if =
        "${{ matrix.phase == 'python' }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r@")).uses =
        "r-lib/actions/setup-r@0000000000000000000000000000000000000000";
    },
    (workflow) => {
      findRDependencies(workflow).uses = "r-lib/actions/setup-r-dependencies@0000000000000000000000000000000000000000";
    },
    (workflow) => {
      findRDependencies(workflow).with.packages = "any::jsonlite";
    },
    (workflow) => {
      findRDependencies(workflow).with["extra-packages"] = findRDependencies(workflow).with["extra-packages"].replace(
        "any::nanoparquet",
        "any::arrow"
      );
    },
    (workflow) => {
      findRDependencies(workflow).with.dependencies = '"all"';
    },
    (workflow) => {
      findRDependencies(workflow).with.cache = false;
    },
    (workflow) => {
      findRDependencies(workflow).with["cache-version"] = "native-r-contract-v2";
    },
    (workflow) => {
      findRDependencies(workflow).with["install-pandoc"] = true;
    },
    (workflow) => {
      findRDependencies(workflow).with["install-quarto"] = true;
    },
    (workflow) => {
      findRDependencies(workflow).if = "${{ matrix.phase == 'python' }}";
    },
    (workflow) => {
      workflow.jobs.platform.steps.push(structuredClone(findRDependencies(workflow)));
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.run === "npm run test:r-contract").env.RSCRIPT = "Rscript";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.push({
        name: "Legacy R package installer",
        if: "${{ matrix.phase == 'r' }}",
        run: "Rscript --vanilla -e 'utils::install.packages (\"jsonlite\")'"
      });
    },
    (workflow) => {
      workflow.jobs.platform.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r@")).uses =
        "r-lib/actions/setup-r@v2";
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => step.run === "npm run test:coverage").run =
        "npm run test:coverage:partial";
    },
    (workflow) => {
      workflow.jobs.performance.steps.find((step) => step.id === "installed_performance").env.PREVIEW_FLAG = "";
    },
    (workflow) => {
      for (const step of workflow.jobs.jupyter.steps.filter(
        (candidate) => candidate.env?.OPEN_WRANGLER_REAL_REMOTE_JUPYTER === "1"
      )) {
        step.env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER = "0";
      }
    },
    (workflow) => {
      workflow.jobs.platform.steps.find((step) => step.id === "packaged_editor")["continue-on-error"] = false;
    },
    (workflow) => {
      const steps = workflow.jobs.platform.steps;
      steps.splice(
        steps.findIndex((step) => step.name === "Fail after VS Code diagnostics"),
        1
      );
    },
    (workflow) => {
      const steps = workflow.jobs.platform.steps;
      steps.splice(
        steps.findIndex((step) => step.id === "canonical_r_jupyter_platform"),
        1
      );
    },
    (workflow) => {
      const steps = workflow.jobs.jupyter.steps;
      steps.splice(
        steps.findIndex((step) => step.id === "packaged_editor"),
        0,
        { run: "echo interposed" }
      );
    },
    (workflow) => {
      const steps = workflow.jobs.jupyter.steps;
      const preparation = steps.splice(
        steps.findIndex((step) => step.id === "prepare_xvfb"),
        1
      )[0];
      steps.splice(steps.findIndex((step) => step.id === "packaged_editor_r") + 1, 0, preparation);
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.id === "prepare_xvfb").run +=
        '\nrequire("node:child_process").execFileSync("sudo", ["apt-get", "install", "r-base"]);';
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.run === "npm ci").if = "${{ matrix.phase == 'r-remote' }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.run === "npm run verify:vsix -- canonical-release/openwrangler.vsix"
      ).if = "${{ matrix.phase != 'r-remote' }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_EDITORS =
        "vscode";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.id === "packaged_editor_r_literate"
      ).env.OPEN_WRANGLER_PACKAGED_R_JOURNEY = "interactive-terminal";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.id === "packaged_editor_r_remote"
      ).env.OPEN_WRANGLER_PACKAGED_R_JOURNEY = "literate-documents";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.id === "packaged_editor_r_remote"
      ).env.OPEN_WRANGLER_PACKAGED_EDITORS = "vscode,cursor";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.id === "packaged_editor_r_remote"
      ).env.OPEN_WRANGLER_TEST_RSCRIPT = "${{ steps.rscript.outputs.executable }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.run === 'python -m pip install -e "python[dev]"').if = undefined;
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.push(
        structuredClone(
          workflow.jobs.jupyter.steps.find((step) => step.run === 'python -m pip install -e "python[dev]"')
        )
      );
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.push(
        structuredClone(
          workflow.jobs.jupyter.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r@"))
        )
      );
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.push({ run: "python -m pip install --upgrade setuptools" });
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.push({ if: "${{ matrix.phase == 'r-remote' }}", run: "sudo apt-get install r-base" });
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.splice(18, 0, {
        if: "${{ matrix.phase == 'r-remote' }}",
        run: "python -m venv .remote-host"
      });
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.splice(31, 0, {
        if: "${{ matrix.phase == 'r-remote' }}",
        run: "Rscript --version"
      });
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.unshift(
        structuredClone(workflow.jobs.jupyter.steps.find((step) => step.id === "canonical_r_remote"))
      );
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.id === "canonical_r_remote").id = "";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => String(step.uses ?? "").startsWith("r-lib/actions/setup-r@")).if =
        "${{ matrix.phase != 'python' }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.name === "Upload R Markdown and Quarto failure diagnostics"
      ).with.name = "preview-release-r-jupyter";
    },
    (workflow) => {
      const upload = workflow.jobs.jupyter.steps.find(
        (step) => step.name === "Upload R Markdown and Quarto failure diagnostics"
      );
      upload.if = "${{ always() && steps.packaged_editor_r_literate.outcome == 'failure' }}";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.name === "Upload R Markdown and Quarto failure diagnostics").with[
        "if-no-files-found"
      ] = "warn";
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find((step) => step.name === "Upload R Markdown and Quarto failure diagnostics").with[
        "include-hidden-files"
      ] = true;
    },
    (workflow) => {
      workflow.jobs.jupyter.steps.find(
        (step) => step.name === "Upload remote R-Jupyter failure diagnostics"
      ).with.name = "${{ inputs.channel }}-release-r-jupyter-local-${{ runner.os }}-${{ github.run_attempt }}";
    },
    (workflow) => {
      const steps = workflow.jobs.jupyter.steps;
      steps.splice(
        steps.findIndex((step) => step.name === "Fail after remote R-Jupyter diagnostics"),
        1
      );
    },
    (workflow) => {
      const steps = workflow.jobs.jupyter.steps;
      const focusedStart = steps.findIndex((step) => step.id === "canonical_r_literate");
      const focused = steps.splice(focusedStart, 4);
      const ordinaryStart = steps.findIndex((step) => step.id === "canonical_r_jupyter");
      steps.splice(ordinaryStart, 0, ...focused);
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => step.id === "packaged_cursor").env.OPEN_WRANGLER_XVFB_EXECUTABLE =
        "Xvfb";
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(
      inspectCandidateAcceptanceWorkflow(mutate(change)),
      [],
      `candidate mutation ${index + 1} must fail closed`
    );
  }
});
