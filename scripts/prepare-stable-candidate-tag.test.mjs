import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareStableCandidateTag } from "./prepare-stable-candidate-tag.mjs";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    windowsHide: true
  }).trim();
}

function createRepository(context) {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-stable-tag-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "release-test@openwrangler.invalid"]);
  git(root, ["config", "user.name", "Open Wrangler Release Test"]);
  writeFileSync(join(root, "tracked.txt"), "first\n", "utf8");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "--quiet", "-m", "first"]);
  const first = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "tracked.txt"), "second\n", "utf8");
  git(root, ["commit", "--quiet", "-am", "second"]);
  return { first, head: git(root, ["rev-parse", "HEAD"]), root };
}

test("creates one unpushed local intended tag and then verifies it idempotently", (context) => {
  const repository = createRepository(context);
  const first = prepareStableCandidateTag({
    expectedCommit: repository.head,
    releaseTag: "v1.0.0",
    root: repository.root
  });
  assert.deepEqual(first, {
    created: true,
    releaseTag: "v1.0.0",
    sourceCommit: repository.head
  });
  assert.equal(git(repository.root, ["rev-parse", "v1.0.0^{commit}"]), repository.head);

  const second = prepareStableCandidateTag({
    expectedCommit: repository.head,
    releaseTag: "v1.0.0",
    root: repository.root
  });
  assert.equal(second.created, false);
});

test("rejects an existing release tag bound to another commit", (context) => {
  const repository = createRepository(context);
  git(repository.root, ["tag", "v1.0.0", repository.first]);
  assert.throws(
    () =>
      prepareStableCandidateTag({
        expectedCommit: repository.head,
        releaseTag: "v1.0.0",
        root: repository.root
      }),
    /existing RELEASE_TAG does not resolve to EXPECTED_SHA/u
  );
  assert.equal(git(repository.root, ["rev-parse", "v1.0.0^{commit}"]), repository.first);
});

test("rejects a stale checkout, dirty tracked source, and noncanonical inputs", (context) => {
  const repository = createRepository(context);
  assert.throws(
    () =>
      prepareStableCandidateTag({
        expectedCommit: repository.first,
        releaseTag: "v1.0.0",
        root: repository.root
      }),
    /must run at EXPECTED_SHA/u
  );

  writeFileSync(join(repository.root, "tracked.txt"), "dirty\n", "utf8");
  assert.throws(
    () =>
      prepareStableCandidateTag({
        expectedCommit: repository.head,
        releaseTag: "v1.0.0",
        root: repository.root
      }),
    /clean tracked worktree/u
  );
  assert.throws(
    () =>
      prepareStableCandidateTag({
        expectedCommit: repository.head.toUpperCase(),
        releaseTag: "v1.0.0",
        root: repository.root
      }),
    /lowercase full Git commit/u
  );
  assert.throws(
    () =>
      prepareStableCandidateTag({
        expectedCommit: repository.head,
        releaseTag: "v1.0.0^{commit}",
        root: repository.root
      }),
    /canonical v<major>/u
  );
});
