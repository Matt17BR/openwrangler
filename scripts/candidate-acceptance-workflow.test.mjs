import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectCandidateAcceptanceWorkflow, inspectCandidateCaller } from "./candidate-acceptance-workflow.mjs";

const source = readFileSync(new URL("../.github/workflows/candidate-acceptance.yml", import.meta.url), "utf8");
const callerSource = readFileSync(new URL("../.github/workflows/release-candidate.yml", import.meta.url), "utf8");

function mutate(change) {
  const workflow = parseYaml(source);
  change(workflow);
  return dumpYaml(workflow);
}

test("candidate acceptance uses seven focused jobs and one immutable VSIX", () => {
  assert.deepEqual(inspectCandidateAcceptanceWorkflow(source), []);
  assert.deepEqual(inspectCandidateCaller(parseYaml(callerSource)), []);
});

test("candidate acceptance allows routine action commit updates", () => {
  const repinned = source.replace(/@[0-9a-f]{40}/gu, `@${"a".repeat(40)}`);
  assert.notEqual(repinned, source);
  assert.deepEqual(inspectCandidateAcceptanceWorkflow(repinned), []);
});

test("candidate acceptance rejects unpinned or unexpected external actions", () => {
  for (const reference of ["actions/checkout@v6", "actions/checkout@deadbeef", "actions/checkout"]) {
    const candidate = source.replace(/actions\/checkout@[0-9a-f]{40}/u, reference);
    assert.notEqual(candidate, source);
    assert.match(inspectCandidateAcceptanceWorkflow(candidate).join("\n"), /full 40-character hexadecimal commit SHA/u);
  }
  const unexpected = mutate((workflow) => {
    workflow.jobs.linux.steps.push({ uses: `example/unexpected-action@${"b".repeat(40)}` });
  });
  assert.match(inspectCandidateAcceptanceWorkflow(unexpected).join("\n"), /is not allowed in this workflow/u);
});

test("candidate acceptance rejects missing platform, Jupyter, R, performance, and artifact safety", () => {
  const cases = [
    (workflow) => delete workflow.jobs.platform,
    (workflow) => {
      workflow.jobs.platform.strategy.matrix.include = [{ os: "ubuntu-24.04", python: "3.12" }];
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => step.id === "packaged_jupyter").env[
        "OPEN_WRANGLER_PACKAGED_PYTHON_JUPYTER_PROFILE"
      ] = "quick";
    },
    (workflow) => {
      workflow.jobs["r-local"].steps.find((step) => step.id === "r_frames").env["OPEN_WRANGLER_PACKAGED_R_JOURNEY"] =
        "core-operations";
    },
    (workflow) => {
      workflow.jobs.performance.steps.find((step) => step.id === "performance_artifact").with.name = "report";
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => step.uses?.startsWith("actions/download-artifact@")).with[
        "artifact-ids"
      ] = "123";
    },
    (workflow) => {
      workflow.jobs.platform.steps.find((step) => step.id === "packaged_platform").env.OPEN_WRANGLER_PACKAGED_MODE =
        "full";
    },
    (workflow) => {
      workflow.jobs.linux.steps.find((step) => step.uses?.startsWith("actions/checkout@")).uses = "actions/checkout@v6";
    },
    (workflow) => {
      workflow.jobs.linux.steps.push({ run: "npx ovsx publish candidate.vsix" });
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(inspectCandidateAcceptanceWorkflow(mutate(change)), [], `mutation ${index + 1} must fail`);
  }
});

test("the caller cannot multiply or detach candidate acceptance", () => {
  const caller = parseYaml(callerSource);
  caller.jobs["candidate-acceptance"].strategy = { matrix: { lane: ["linux", "windows"] } };
  assert.notDeepEqual(inspectCandidateCaller(caller), []);
  delete caller.jobs["candidate-acceptance"].strategy;
  caller.jobs["candidate-acceptance"].with.artifact_id = "some-name";
  assert.notDeepEqual(inspectCandidateCaller(caller), []);
});
