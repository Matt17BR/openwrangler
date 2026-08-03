import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { inspectPublicWriting, PUBLIC_WRITING_SURFACES } from "./public-writing.mjs";

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

test("the structural check names every public surface", () => {
  assert.deepEqual(PUBLIC_WRITING_SURFACES, [
    "README",
    "user documentation",
    "contributor documentation",
    "changelog",
    "GitHub issues",
    "pull requests",
    "commit subjects and `git log`",
    "release notes",
    "Marketplace listings",
    "Open VSX listings",
    "screenshot captions",
    "image alt text"
  ]);
});

test("dropping any public surface from the guide coverage statement fails", () => {
  for (const surface of PUBLIC_WRITING_SURFACES) {
    const copy = repositoryCopy();
    copy.styleGuide = copy.styleGuide.replace(surface, "[removed public surface]");
    assert.ok(
      inspectPublicWriting(copy).some((problem) => problem.includes(surface)),
      `Expected the structural check to reject a missing ${surface} route.`
    );
  }
});

test("precise methodology terms do not affect the objective routing check", () => {
  const copy = repositoryCopy();
  copy.styleGuide += "\nA reproducible black-box study may define exact timing boundaries.\n";
  assert.deepEqual(inspectPublicWriting(copy), []);
});
