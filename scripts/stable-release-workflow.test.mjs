import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectReleaseCandidateWorkflow, inspectStableReleaseWorkflow } from "./stable-release-workflow.mjs";

const candidateSource = readFileSync(new URL("../.github/workflows/release-candidate.yml", import.meta.url), "utf8");
const stableSource = readFileSync(new URL("../.github/workflows/stable-release.yml", import.meta.url), "utf8");

function mutate(source, change) {
  const workflow = parseYaml(source);
  change(workflow);
  return dumpYaml(workflow);
}

function repinActions(source) {
  return source.replace(/@[0-9a-f]{40}/gu, `@${"a".repeat(40)}`);
}

test("release candidate builds once and qualifies ten expanded jobs", () => {
  assert.deepEqual(inspectReleaseCandidateWorkflow(candidateSource), []);
  assert.doesNotMatch(candidateSource, /test "\$RUN_ATTEMPT" = "1"|seven-day|soak/u);
});

test("release workflows accept routine action commit updates", () => {
  const repinnedCandidate = repinActions(candidateSource);
  const repinnedStable = repinActions(stableSource);
  assert.notEqual(repinnedCandidate, candidateSource);
  assert.notEqual(repinnedStable, stableSource);
  assert.deepEqual(inspectReleaseCandidateWorkflow(repinnedCandidate), []);
  assert.deepEqual(inspectStableReleaseWorkflow(repinnedStable), []);
});

test("release workflows reject unpinned and unexpected actions or reusable workflows", () => {
  for (const reference of ["actions/checkout@v7", "actions/checkout@deadbeef", "actions/checkout"]) {
    const candidate = candidateSource.replace(/actions\/checkout@[0-9a-f]{40}/u, reference);
    assert.notEqual(candidate, candidateSource);
    assert.match(inspectReleaseCandidateWorkflow(candidate).join("\n"), /full 40-character hexadecimal commit SHA/u);
  }

  const unexpectedCandidate = mutate(candidateSource, (workflow) => {
    workflow.jobs.package.steps.push({ uses: `example/unexpected-action@${"b".repeat(40)}` });
  });
  assert.match(inspectReleaseCandidateWorkflow(unexpectedCandidate).join("\n"), /is not allowed in this workflow/u);

  const unexpectedStable = mutate(stableSource, (workflow) => {
    workflow.jobs.publish.steps.push({ uses: `example/unexpected-action@${"b".repeat(40)}` });
  });
  assert.match(inspectStableReleaseWorkflow(unexpectedStable).join("\n"), /is not allowed in this workflow/u);

  const wrongReusable = mutate(stableSource, (workflow) => {
    workflow.jobs["open-vsx"].uses = "./.github/workflows/candidate-acceptance.yml";
  });
  assert.match(inspectStableReleaseWorkflow(wrongReusable).join("\n"), /is not allowed in this workflow/u);
});

test("release candidate rejects rebuild, publication, unbound artifact, and missing owner drift", () => {
  const cases = [
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => String(step.run ?? "").includes("package:prepared")).run +=
        "\nnpm run package:prepared -- --out second.vsix";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.id === "candidate_artifact").with.name = "candidate";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.find((step) => step.uses?.startsWith("actions/download-artifact@")).with[
        "artifact-ids"
      ] = "99";
    },
    (workflow) => {
      workflow.jobs.qualify.needs = ["package", "remote-ssh"];
    },
    (workflow) => {
      workflow.jobs.qualify.steps.push({ run: "node scripts/push-stable-release-tag.mjs" });
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.uses?.startsWith("actions/checkout@")).uses =
        "actions/checkout@v6";
    },
    (workflow) => {
      delete workflow.concurrency.queue;
    },
    (workflow) => {
      workflow.concurrency.unsupported = true;
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(inspectReleaseCandidateWorkflow(mutate(candidateSource, change)), [], `mutation ${index + 1}`);
  }
});

test("stable release publishes GitHub once from one selected candidate", () => {
  assert.deepEqual(inspectStableReleaseWorkflow(stableSource), []);
  assert.doesNotMatch(stableSource, /ovsx publish|verify-open-vsx|seven-day|soak/u);
});

test("stable release rejects selection, permission, download, rebuild, and duplicate publisher drift", () => {
  const cases = [
    (workflow) => {
      workflow.jobs.select.permissions.actions = "write";
    },
    (workflow) => {
      workflow.jobs.select.steps.find((step) => step.id === "candidate").run = "echo selected";
    },
    (workflow) => {
      delete workflow.jobs.select.outputs["candidate-run-attempt"];
    },
    (workflow) => {
      workflow.jobs.select.steps.find((step) => String(step.name ?? "").includes("current main")).run =
        'git merge-base --is-ancestor "$CANDIDATE_SOURCE_SHA" "$CURRENT_MAIN_SHA"';
    },
    (workflow) => {
      delete workflow.concurrency.queue;
    },
    (workflow) => {
      workflow.jobs.publish.environment = "unprotected";
    },
    (workflow) => {
      workflow.jobs.publish.permissions.contents = "read";
    },
    (workflow) => {
      delete workflow.jobs.publish.concurrency.queue;
    },
    (workflow) => {
      workflow.jobs.publish.concurrency.unsupported = true;
    },
    (workflow) => {
      workflow.jobs.publish.steps.find((step) => step.name === "Download the candidate bytes").with["run-id"] =
        "${{ github.run_id }}";
    },
    (workflow) => {
      workflow.jobs.publish.steps.find((step) => String(step.run ?? "").includes("release-candidate.mjs verify")).env[
        "CANDIDATE_RUN_ATTEMPT"
      ] = "1";
    },
    (workflow) => {
      workflow.jobs.publish.steps.push({ run: "npm run build && npx ovsx publish rebuilt.vsix" });
    },
    (workflow) => {
      workflow.jobs.publish.steps.find((step) => step.uses?.startsWith("actions/checkout@")).uses =
        "actions/checkout@v6";
    },
    (workflow) => {
      workflow.jobs["open-vsx"].secrets = "inherit";
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(inspectStableReleaseWorkflow(mutate(stableSource, change)), [], `mutation ${index + 1}`);
  }
});
