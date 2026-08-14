import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dump as dumpYaml, load as parseYaml } from "js-yaml";
import { inspectCandidateAcceptanceWorkflow, inspectCandidateCaller } from "./candidate-acceptance-workflow.mjs";

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

test("rejects invalid or oversized workflow text", () => {
  assert.match(inspectCandidateAcceptanceWorkflow("not: [yaml")[0], /valid YAML/u);
  assert.match(inspectCandidateAcceptanceWorkflow("x".repeat(2 * 1024 * 1024 + 1))[0], /bounded YAML/u);
});

test("requires exactly four inputs, no outputs, and eight fixed jobs", () => {
  expectRejected((value) => {
    value.on.workflow_call.outputs = { accepted: { value: "true" } };
  }, /four required inputs, no outputs/u);
  expectRejected((value) => {
    value.on.workflow_call.inputs.lane = { required: true, type: "string" };
  }, /four required inputs/u);
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

test("linux and performance remain fixed parallel siblings", () => {
  expectRejected((value) => {
    value.jobs.linux.needs = ["contract", "platform"];
  }, /fixed runner and direct dependency/u);
  expectRejected((value) => {
    value.jobs.performance["runs-on"] = "${{ inputs.runner_os }}";
  }, /fixed runner and direct dependency/u);
  expectRejected((value) => {
    step(value.jobs.linux, (entry) => entry.run === "npm run test:coverage").run = "true";
  }, /source, webview, coverage/u);
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

test("r_contract and r_local depend only on contract and run as siblings", () => {
  expectRejected((value) => {
    value.jobs.r_contract.needs = "jupyter";
  }, /fixed runner|artifact-independent sibling/u);
  expectRejected((value) => {
    value.jobs.r_local.needs = ["contract", "r_contract"];
  }, /fixed runner|beside r_contract/u);
  expectRejected((value) => {
    value.jobs.r_contract.steps.push({
      uses: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"
    });
  }, /artifact-independent sibling/u);
});

test("r_contract owns the exact hosted R dependency contract once", () => {
  expectRejected((value) => {
    step(value.jobs.r_contract, (entry) => entry.uses?.startsWith("r-lib/actions/setup-r-dependencies@")).with[
      "extra-packages"
    ] += "\nany::IRkernel";
  }, /exact hosted R 4\.5\.2 package contract/u);
  expectRejected((value) => {
    step(value.jobs.r_contract, (entry) => entry.run === "npm run test:r-contract").env.RSCRIPT = "Rscript";
  }, /native contract once/u);
  expectRejected((value) => {
    value.jobs.r_contract.steps.push({ run: 'Rscript -e "install.packages("jsonlite")"' });
  }, /exact hosted R/u);
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

test("core uses the explicit selector and all local phases keep VS Code then Cursor in one runner", () => {
  for (const [id, journey] of [
    ["packaged_editor_r_core", "core-operations"],
    ["packaged_editor_r_interactive", "interactive-terminal"],
    ["packaged_editor_r_literate", "literate-documents"],
    ["packaged_editor_r_values", "value-operations"],
    ["packaged_editor_r_categorical", "categorical-operations"]
  ]) {
    const value = workflow();
    const runner = step(value.jobs.r_local, (entry) => entry.id === id);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY, journey);
    assert.equal(runner.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode,cursor");
  }
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.id === "packaged_editor_r_core").env.OPEN_WRANGLER_PACKAGED_R_JOURNEY =
      "value-operations";
  }, /verifier.*packaged phase.*upload/u);
});

test("every local phase has an adjacent verifier and immediate exact failure upload", () => {
  expectRejected((value) => {
    const steps = value.jobs.r_local.steps;
    const runner = steps.findIndex((entry) => entry.id === "packaged_editor_r_interactive");
    steps.splice(runner, 0, { run: "true" });
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
    step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes").if =
      "${{ success() }}";
  }, /literal raw-outcome verdict/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.name === "Require successful local R shard outcomes").run =
      'test "$CORE_OUTCOME" != "failure"';
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
});

test("all action references remain immutable and diagnostics channel-scoped", () => {
  expectRejected((value) => {
    value.jobs.r_local.steps.find((entry) => entry.uses?.startsWith("actions/download-artifact@")).uses =
      "actions/download-artifact@v8";
  }, /pinned to one full commit/u);
  expectRejected((value) => {
    step(value.jobs.r_local, (entry) => entry.name === "Upload local R-Jupyter failure diagnostics").with.name =
      "local-r-failure";
  }, /namespaced by the requested release channel/u);
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
