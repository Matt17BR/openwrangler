import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectCandidateAcceptanceWorkflow } from "./candidate-acceptance-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/candidate-acceptance.yml", import.meta.url), "utf8");

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
      workflow.jobs.jupyter.steps.find((step) => step.id === "packaged_editor").env.OPEN_WRANGLER_PACKAGED_EDITORS =
        "vscode";
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
