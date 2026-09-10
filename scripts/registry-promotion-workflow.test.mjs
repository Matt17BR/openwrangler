import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { dump, load } from "js-yaml";
import { inspectMarketplacePromotionPipeline } from "./marketplace-promotion-workflow.mjs";
import { inspectOpenVsxPromotionWorkflow } from "./open-vsx-promotion-workflow.mjs";

const root = resolve(import.meta.dirname, "..");
const marketplace = readFileSync(resolve(root, "azure-pipelines-marketplace.yml"), "utf8");
const openVsx = readFileSync(resolve(root, ".github/workflows/open-vsx-promotion.yml"), "utf8");
const marketplaceSteps = (workflow) => workflow.stages[1].jobs[0].strategy.runOnce.deploy.steps;

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

test("stable promotion waits for the shared registry owner without holding its lock or forwarding secrets", () => {
  const stable = load(readFileSync(resolve(root, ".github/workflows/stable-release.yml"), "utf8"));
  const called = load(openVsx);
  const caller = stable.jobs["open-vsx"];
  assert.equal(caller.uses, "./.github/workflows/open-vsx-promotion.yml");
  assert.equal(caller.needs, "promote");
  assert.equal(caller.if, undefined);
  assert.equal(caller["continue-on-error"], undefined);
  assert.equal(caller.secrets, undefined);
  assert.equal(caller.concurrency, undefined);
  assert.deepEqual(caller.permissions, { contents: "read" });
  assert.deepEqual(caller.with, { release_tag: "${{ inputs.release_tag }}" });
  assert.equal(called.on.workflow_call.inputs.release_tag.required, true);
  assert.equal(called.on.workflow_call.inputs.release_tag.default, undefined);
  assert.equal(called.on.workflow_call.secrets, undefined);
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
});
