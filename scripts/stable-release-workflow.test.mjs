import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectStableReleaseWorkflow } from "./stable-release-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/stable-release.yml", import.meta.url), "utf8");

test("ordinary stable release packages once and gates publishing behind exact-artifact consumers", () => {
  assert.deepEqual(inspectStableReleaseWorkflow(source), []);
});

test("stable release inspector rejects unsafe publication and artifact drift", () => {
  const mutate = (change) => {
    const workflow = parseYaml(source);
    change(workflow);
    return dumpYaml(workflow);
  };
  const cases = [
    (workflow) => {
      workflow.on.workflow_dispatch.inputs.publish.default = true;
    },
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.id === "canonical").run = "echo accepted";
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy["fail-fast"] = true;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy["max-parallel"] = 1;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.exclude = [{ lane: "jupyter" }];
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.experimental = [false];
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].strategy.matrix.include.pop();
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].uses = "./.github/workflows/other.yml";
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].with.channel = "preview";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].needs = ["package", "candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.find((step) => step.id === "remote_workspace").run = "echo skipped";
    },
    (workflow) => {
      workflow.jobs.release.needs = ["package", "candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs.release.needs = ["package", "remote-ssh"];
    },
    (workflow) => {
      workflow.jobs.release.needs = ["candidate-acceptance", "remote-ssh"];
    },
    (workflow) => {
      workflow.jobs.release.if = "${{ inputs.publish != false }}";
    },
    (workflow) => {
      workflow.jobs.release.environment = "unprotected";
    },
    (workflow) => {
      workflow.jobs.release["timeout-minutes"] = 19;
    },
    (workflow) => {
      workflow.jobs.release.concurrency.queue = "latest";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => step.run === "node scripts/push-stable-release-tag.mjs").run =
        "git push --force origin ${{ inputs.release_tag }}";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => step.env?.GITHUB_TOKEN === "${{ github.token }}").env.GITHUB_TOKEN =
        "literal-token";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) => String(step.run ?? "").includes("ovsx publish")).run =
        "echo published";
    },
    (workflow) => {
      workflow.jobs.release.steps.find((step) =>
        String(step.run ?? "").includes("verify-public-media-surfaces.mjs")
      ).run = "echo media verified";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => String(step.run ?? "").includes("--prepublish")).run =
        "echo media preflight skipped";
    },
    (workflow) => {
      const packageSteps = workflow.jobs.package.steps;
      const preflightIndex = packageSteps.findIndex((step) => String(step.run ?? "").includes("--prepublish"));
      const [preflight] = packageSteps.splice(preflightIndex, 1);
      packageSteps.push(preflight);
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(
      inspectStableReleaseWorkflow(mutate(change)),
      [],
      `stable mutation ${index + 1} must fail closed`
    );
  }
});
