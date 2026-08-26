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
  return mutate(source, (workflow) => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.uses === "string" && !step.uses.startsWith("./")) {
          step.uses = step.uses.replace(/@[0-9a-f]{40}$/u, `@${"a".repeat(40)}`);
        }
      }
    }
  });
}

test("release candidate packages once and seals read-only qualification", () => {
  assert.deepEqual(inspectReleaseCandidateWorkflow(candidateSource), []);
});

test("release checks accept updated action commits", () => {
  assert.deepEqual(inspectReleaseCandidateWorkflow(repinActions(candidateSource)), []);
  assert.deepEqual(inspectStableReleaseWorkflow(repinActions(stableSource)), []);
});

test("release inspectors reject tag, short, malformed, and extra external action references", () => {
  const inspectors = [
    [candidateSource, inspectReleaseCandidateWorkflow],
    [stableSource, inspectStableReleaseWorkflow]
  ];
  for (const [source, inspect] of inspectors) {
    for (const reference of ["actions/checkout@v6", "actions/checkout@deadbeef", "actions/checkout"]) {
      const candidate = source.replace(/actions\/checkout@[0-9a-f]{40}/u, reference);
      assert.notEqual(candidate, source);
      assert.match(inspect(candidate).join("\n"), /full 40-character hexadecimal commit SHA/u);
    }
    const candidate = mutate(source, (workflow) => {
      Object.values(workflow.jobs)
        .find((job) => Array.isArray(job.steps))
        .steps.push({
          uses: "example/unreviewed-action@v1"
        });
    });
    assert.match(inspect(candidate).join("\n"), /full 40-character hexadecimal commit SHA/u);
  }
});

test("release jobs reject unexpected fully pinned actions and reusable workflows", () => {
  const commit = "b".repeat(40);
  const candidateCases = [
    (workflow) => {
      workflow.jobs.package.steps.push({ uses: `example/unexpected-action@${commit}` });
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.push({ uses: `actions/setup-python@${commit}` });
    },
    (workflow) => {
      workflow.jobs.qualify.steps.push({
        uses: `example/unexpected-action@${commit}`,
        env: { GITHUB_TOKEN: "${{ github.token }}" }
      });
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].uses = `example/workflows/.github/workflows/accept.yml@${commit}`;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].uses = "./.github/workflows/other.yml";
    }
  ];
  for (const change of candidateCases) {
    assert.match(
      inspectReleaseCandidateWorkflow(mutate(candidateSource, change)).join("\n"),
      /is not allowed in this workflow/u
    );
  }

  const stableCases = [
    (workflow) => {
      workflow.jobs.select.steps.push({ uses: `actions/download-artifact@${commit}` });
    },
    (workflow) => {
      workflow.jobs.promote.steps.push({
        uses: `example/unexpected-action@${commit}`,
        env: { GITHUB_TOKEN: "${{ github.token }}" }
      });
    }
  ];
  for (const change of stableCases) {
    assert.match(
      inspectStableReleaseWorkflow(mutate(stableSource, change)).join("\n"),
      /is not allowed in this workflow/u
    );
  }
});

test("release-candidate inspector rejects publication, rebuilding, artifact, and fan-in drift", () => {
  const cases = [
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.concurrency.group = "release-candidate-${{ inputs.release_tag }}";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => String(step.run ?? "").includes("package:prepared")).run =
        "npm run build && npm run package:prepared -- --out first.vsix && npm run package:prepared -- --out second.vsix";
    },
    (workflow) => {
      workflow.jobs.package.steps.find((step) => step.id === "canonical_artifact").with["retention-days"] = 6;
    },
    (workflow) => {
      workflow.jobs["candidate-acceptance"].with.channel = "preview";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].needs = "candidate-acceptance";
    },
    (workflow) => {
      workflow.jobs["remote-ssh"].steps.find((step) => step.uses?.startsWith("actions/download-artifact@")).with[
        "artifact-ids"
      ] = "123";
    },
    (workflow) => {
      workflow.jobs.qualify.if = "${{ success() }}";
    },
    (workflow) => {
      workflow.jobs.qualify.needs = ["package", "candidate-acceptance"];
    },
    (workflow) => {
      workflow.jobs.qualify.steps.find((step) => String(step.run ?? "").includes("REMOTE_SSH_RESULT")).run =
        "echo ignored";
    },
    (workflow) => {
      workflow.jobs.qualify.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")).with.name =
        "unbounded-evidence";
    },
    (workflow) => {
      workflow.jobs.qualify.steps.push({ run: "node scripts/push-stable-release-tag.mjs" });
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(
      inspectReleaseCandidateWorkflow(mutate(candidateSource, change)),
      [],
      `candidate mutation ${index + 1} must fail closed`
    );
  }
});

test("stable release promotes only one soaked candidate without rebuilding", () => {
  assert.deepEqual(inspectStableReleaseWorkflow(stableSource), []);
});

test("stable-release inspector rejects selection, identity, permission, download, and publication drift", () => {
  const cases = [
    (workflow) => {
      workflow.on.workflow_dispatch.inputs.publish = { required: true, type: "boolean" };
    },
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.concurrency.group = "stable-release-${{ inputs.release_tag }}";
    },
    (workflow) => {
      workflow.jobs.select.permissions.actions = "write";
    },
    (workflow) => {
      workflow.jobs.select.steps.find((step) => String(step.run ?? "").includes("RUN_ATTEMPT")).run =
        'test "$EVENT_REF" = "refs/heads/main"';
    },
    (workflow) => {
      workflow.jobs.select.steps.find((step) => step.id === "candidate").env.CANDIDATE_RUN_ID = "99";
    },
    (workflow) => {
      workflow.jobs.select.steps.find((step) => String(step.run ?? "").includes("merge-base")).run = "echo ancestor";
    },
    (workflow) => {
      workflow.jobs.promote.environment = "unprotected";
    },
    (workflow) => {
      workflow.jobs.promote.permissions.contents = "read";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.name === "Check out the historical candidate source").with.ref =
        "${{ github.sha }}";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.name === "Download the exact candidate artifact").with["run-id"] =
        "${{ github.run_id }}";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.name === "Download the bounded candidate manifest").with[
        "artifact-ids"
      ] = "${{ needs.select.outputs.candidate-artifact-id }}";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => String(step.run ?? "").includes("release-candidate.mjs verify")).env[
        "CANDIDATE_SOURCE_SHA"
      ] = "${{ github.sha }}";
    },
    (workflow) => {
      workflow.jobs.promote.steps.push({ run: "npm run build && npm run package -- --out rebuilt.vsix" });
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => String(step.run ?? "").includes("--preflight")).run = "echo safe";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => String(step.run ?? "").includes("ovsx publish")).run =
        "echo published";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.id === "canonical_release").env.EXPECTED_SHA =
        "${{ github.sha }}";
    }
  ];
  for (const [index, change] of cases.entries()) {
    assert.notDeepEqual(
      inspectStableReleaseWorkflow(mutate(stableSource, change)),
      [],
      `stable mutation ${index + 1} must fail closed`
    );
  }
});
