import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { inspectPublicWriting } from "./public-writing.mjs";

const root = resolve(import.meta.dirname, "..");

function repositoryCopy() {
  return {
    agentGuide: readFileSync(resolve(root, "AGENTS.md"), "utf8"),
    contributing: readFileSync(resolve(root, "CONTRIBUTING.md"), "utf8"),
    pullRequestTemplate: readFileSync(resolve(root, ".github/pull_request_template.md"), "utf8"),
    styleGuide: readFileSync(resolve(root, "docs/writing-style.md"), "utf8")
  };
}

test("repository public writing follows the checked-in maintainer guidance", () => {
  assert.deepEqual(inspectPublicWriting(repositoryCopy()), []);
});

test("missing review routes and pull request sections fail", () => {
  const copy = repositoryCopy();
  copy.agentGuide = copy.agentGuide.replaceAll("docs/writing-style.md", "docs/missing.md");
  copy.pullRequestTemplate = copy.pullRequestTemplate.replace("## Verification", "Verification");
  const problems = inspectPublicWriting(copy);
  assert.ok(problems.some((problem) => problem.includes("AGENTS.md")));
  assert.ok(problems.some((problem) => problem.includes("## Verification")));
});

test("dropping a public surface from the guide fails", () => {
  const copy = repositoryCopy();
  copy.styleGuide = copy.styleGuide.replace("Marketplace and Open VSX listings", "registry copy");
  assert.ok(inspectPublicWriting(copy).some((problem) => problem.includes("Marketplace and Open VSX listings")));
});

test("precise methodology terms do not affect the objective routing check", () => {
  const copy = repositoryCopy();
  copy.styleGuide += "\nA reproducible black-box study may define exact timing boundaries.\n";
  assert.deepEqual(inspectPublicWriting(copy), []);
});
