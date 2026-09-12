import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { dump, load } from "js-yaml";
import { inspectMarketplacePromotionPipeline } from "./marketplace-promotion-workflow.mjs";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const marketplace = readFileSync(resolve(root, "azure-pipelines-marketplace.yml"), "utf8");
const openVsx = readFileSync(resolve(root, ".github/workflows/open-vsx-promotion.yml"), "utf8");
const marketplaceSteps = (workflow) => workflow.stages[1].jobs[0].strategy.runOnce.deploy.steps;

test("R candidate qualification consumes the same immutable artifact on every desktop platform", () => {
  const workflow = load(readFileSync(resolve(root, ".github/workflows/release-candidate.yml"), "utf8"));
  const job = workflow.jobs["r-notebook"];
  assert.ok(job, "the candidate run must require R notebook qualification");
  assert.equal(job.needs, "candidate");
  assert.equal(job.if, undefined);
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.strategy["fail-fast"], false);
  assert.deepEqual(
    job.strategy.matrix.include.map(({ os }) => os),
    ["ubuntu-24.04", "macos-latest", "windows-latest"]
  );
  assert.equal(job["runs-on"], "${{ matrix.os }}");
  const steps = job.steps;
  assert.ok(steps.every((step) => step["continue-on-error"] === undefined));
  const checkout = steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref, "${{ github.sha }}");
  assert.equal(checkout.with["persist-credentials"], false);
  const downloadIndex = steps.findIndex((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.deepEqual(steps[downloadIndex].with, {
    name: "openwrangler-release-candidate",
    path: "canonical-release"
  });
  const verification = steps.flatMap((step, index) =>
    step.run === "node scripts/verify-canonical-release-artifact.mjs canonical-release" ? [index] : []
  );
  const harnessIndex = steps.findIndex((step) => step.run === "npm run build:test-extension");
  const runIndex = steps.findIndex((step) => step.id === "r_notebook");
  assert.equal(verification.length, 2);
  assert.ok(downloadIndex < verification[0] && verification[0] < harnessIndex && harnessIndex < runIndex);
  assert.ok(runIndex < verification[1]);
  for (const index of verification) {
    assert.equal(steps[index].if, undefined);
    assert.deepEqual(steps[index].env, {
      EXPECTED_SHA: "${{ github.sha }}",
      RELEASE_TAG: "${{ inputs.release_tag }}"
    });
  }
  const run = steps[runIndex];
  assert.equal(run.if, undefined);
  assert.equal(run.env.OPEN_WRANGLER_PACKAGED_MODE, "r-jupyter");
  assert.equal(run.env.OPEN_WRANGLER_PACKAGED_EDITORS, "vscode");
  assert.equal(run.env.OPEN_WRANGLER_REAL_JUPYTER_EXTENSION, "1");
  assert.equal(run.env.OPEN_WRANGLER_REAL_REMOTE_JUPYTER, "0");
  assert.equal(run.env.OPEN_WRANGLER_TEST_RSCRIPT, "${{ steps.rscript.outputs.executable }}");
  assert.equal(run.env.OPEN_WRANGLER_PACKAGED_R_JOURNEY, undefined);
  assert.equal(run.env.OPEN_WRANGLER_TEST_SELECTOR, undefined);
  assert.match(run.run, /node scripts\/run-packaged-editor-tests\.mjs canonical-release\/openwrangler\.vsix/u);
  assert.doesNotMatch(
    steps.map((step) => step.run ?? "").join("\n"),
    /npm run (?:clean|build(?:\s|$)|package)|python\[dev\]|run-r-contract-tests|vitest|pytest/u
  );
  const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].if, /steps\.r_notebook\.outcome == 'failure'/u);
});

for (const [name, source, inspect] of [
  ["Marketplace", marketplace, inspectMarketplacePromotionPipeline],
  ["Open VSX", openVsx, inspectOpenVsxPromotionWorkflow]
]) {
  test(`${name} safety checks accept comments, display names and harmless step spacing`, () => {
    assert.deepEqual(inspect(source), []);
    const workflow = load(source);
    workflow.name = "A clearer publication name";
    const steps = name === "Marketplace" ? marketplaceSteps(workflow) : workflow.jobs.promote.steps;
    steps[0].displayName = "A clearer checkout description";
    steps.splice(
      2,
      0,
      name === "Marketplace" ? { script: "echo Preparing the release" } : { run: "echo Preparing the release" }
    );
    assert.deepEqual(inspect(`# Maintainer explanation\n${dump(workflow)}`), []);
  });
}

test("Open VSX rejects missing, skipped and tolerated mandatory artifact checks", () => {
  for (const command of [
    "node scripts/verify-registry-release-artifact.mjs canonical-release",
    "node scripts/verify-open-vsx-github-release.mjs canonical-release --preflight",
    "node scripts/verify-open-vsx-github-release.mjs canonical-release --verify"
  ]) {
    for (const mode of ["missing", "skipped", "tolerated"]) {
      const workflow = load(openVsx);
      const steps = workflow.jobs.promote.steps;
      for (let index = steps.length - 1; index >= 0; index--) {
        if (steps[index].run !== command) continue;
        if (mode === "missing") steps.splice(index, 1);
        else if (mode === "skipped") steps[index].if = "${{ false }}";
        else steps[index]["continue-on-error"] = true;
      }
      assert.notDeepEqual(inspectOpenVsxPromotionWorkflow(dump(workflow)), [], `${command}: ${mode}`);
    }
  }
});

test("Marketplace rejects missing, skipped and tolerated release verification", () => {
  for (const command of [
    "node scripts/marketplace-release-intake.mjs",
    "node scripts/verify-registry-release-artifact.mjs canonical-release",
    "node scripts/verify-marketplace-publication.mjs canonical-release --probe-existing",
    "node scripts/verify-marketplace-publication.mjs canonical-release"
  ]) {
    for (const mode of ["missing", "skipped", "tolerated"]) {
      const workflow = load(marketplace);
      const steps = command.includes("release-intake") ? workflow.stages[0].jobs[0].steps : marketplaceSteps(workflow);
      const index = steps.findIndex((step) => step.script === command);
      assert.notEqual(index, -1);
      if (mode === "missing") steps.splice(index, 1);
      else if (mode === "skipped") steps[index].condition = "false";
      else steps[index].continueOnError = true;
      assert.notDeepEqual(inspectMarketplacePromotionPipeline(dump(workflow)), [], `${command}: ${mode}`);
    }
  }
});

test("Open VSX retains source, permission and credential boundaries", () => {
  for (const mutate of [
    (workflow) => {
      workflow.permissions.contents = "write";
    },
    (workflow) => {
      workflow.jobs.promote.env.OVSX_PAT = "${{ secrets.OVSX_PAT }}";
    },
    (workflow) => {
      workflow.jobs.promote.environment = "unprotected";
    },
    (workflow) => {
      workflow.env = { EXPOSED: "${{ toJSON(secrets) }}" };
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.with?.ref === "main").with["persist-credentials"] = true;
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.with?.ref === "main").with.ref = "unreviewed";
    },
    (workflow) => {
      workflow.jobs.promote.steps.find((step) => step.run?.includes("--preflight")).env.EXPECTED_SHA =
        "${{ github.sha }}";
    },
    (workflow) => {
      workflow.jobs.promote.steps.push({ run: "npm run build" });
    }
  ]) {
    const workflow = load(openVsx);
    mutate(workflow);
    assert.notDeepEqual(inspectOpenVsxPromotionWorkflow(dump(workflow)), []);
  }
});

test("Marketplace retains WIF, source and immutable-package boundaries", () => {
  for (const mutate of [
    (workflow) => {
      workflow.parameters[0].values.push("other-identity");
    },
    (workflow) => {
      marketplaceSteps(workflow).find((step) => step.task === "AzureCLI@2").inputs.addSpnToEnvironment = true;
    },
    (workflow) => {
      marketplaceSteps(workflow).find((step) => step.script?.includes("--probe-existing")).env.EXPECTED_SHA =
        "$(Build.SourceVersion)";
    },
    (workflow) => {
      workflow.stages[0].condition = "false";
    },
    (workflow) => {
      marketplaceSteps(workflow).push({ script: "npm run package" });
    }
  ]) {
    const workflow = load(marketplace);
    mutate(workflow);
    assert.notDeepEqual(inspectMarketplacePromotionPipeline(dump(workflow)), []);
  }
});

test("stable promotion dispatches the protected registry owner without holding its lock or forwarding secrets", (context) => {
  const stable = load(readFileSync(resolve(root, ".github/workflows/stable-release.yml"), "utf8"));
  const called = load(openVsx);
  const caller = stable.jobs["open-vsx"];
  assert.equal(caller.needs, "promote");
  assert.equal(caller.if, undefined);
  assert.equal(caller["continue-on-error"], undefined);
  assert.equal(caller.secrets, undefined);
  assert.equal(caller.concurrency, undefined);
  assert.equal(caller.environment, undefined);
  assert.deepEqual(caller.permissions, { actions: "write", contents: "read" });
  assert.equal(caller.steps.length, 1);
  const dispatch = caller.steps[0];
  assert.equal(dispatch.if, undefined);
  assert.equal(dispatch["continue-on-error"], undefined);
  assert.deepEqual(dispatch.env, {
    GH_TOKEN: "${{ github.token }}",
    GITHUB_REPOSITORY: "${{ github.repository }}",
    RELEASE_TAG: "${{ inputs.release_tag }}"
  });
  assert.equal(called.jobs.promote.environment, "publishing");
  assert.notEqual(stable.concurrency.group, called.concurrency.group);
  assert.equal(stable.concurrency["cancel-in-progress"], false);
  assert.equal(called.concurrency["cancel-in-progress"], false);
  assert.ok(stable.jobs.promote.steps.some((step) => step.run?.includes("publish-github-stable-release.mjs")));
  assert.ok(
    stable.jobs.promote.steps.every(
      (step) => !JSON.stringify(step).includes("ovsx") && !JSON.stringify(step).includes("OVSX_PAT")
    )
  );

  const directory = mkdtempSync(join(tmpdir(), "ow-registry-dispatch-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const argsFile = join(directory, "args");
  writeFileSync(
    join(directory, "gh"),
    '#!/bin/sh\numask 077\nprintf "%s\\n" "$@" > "$DISPATCH_ARGS_FILE"\nexit "$DISPATCH_EXIT_CODE"\n',
    { mode: 0o700 }
  );
  for (const exitCode of [0, 23]) {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", dispatch.run], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        GH_TOKEN: "test-only",
        GITHUB_REPOSITORY: "Matt17BR/openwrangler",
        RELEASE_TAG: "v2.1.1",
        DISPATCH_ARGS_FILE: argsFile,
        DISPATCH_EXIT_CODE: String(exitCode)
      }
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, exitCode);
    assert.deepEqual(readFileSync(argsFile, "utf8").trimEnd().split("\n"), [
      "workflow",
      "run",
      "open-vsx-promotion.yml",
      "--repo",
      "Matt17BR/openwrangler",
      "--ref",
      "main",
      "--raw-field",
      "release_tag=v2.1.1"
    ]);
  }
});
