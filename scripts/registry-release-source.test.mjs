import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectRegistryReleaseManifest, readRegistryReleaseSource } from "./registry-release-source.mjs";

function manifest({ preview = false, version = "1.0.1" } = {}) {
  return JSON.stringify({
    displayName: "Open Wrangler",
    name: "openwrangler",
    preview,
    publisher: "Matt17BR",
    version
  });
}

function git(root, arguments_) {
  return execFileSync("git", arguments_, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
}

function repository(context, packageJson = manifest()) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-registry-source-")));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "registry-test@openwrangler.invalid"]);
  git(root, ["config", "user.name", "Open Wrangler Registry Test"]);
  git(root, ["remote", "add", "origin", "https://github.com/Matt17BR/openwrangler.git"]);
  writeFileSync(join(root, "package.json"), packageJson, "utf8");
  git(root, ["add", "package.json"]);
  git(root, ["commit", "--quiet", "-m", "release"]);
  const version = JSON.parse(packageJson).version;
  git(root, ["tag", `v${version}`]);
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return root;
}

test("classifies exact stable and preview source manifests", () => {
  assert.deepEqual(inspectRegistryReleaseManifest({ packageJson: manifest(), releaseTag: "v1.0.1" }).problems, []);
  assert.equal(
    inspectRegistryReleaseManifest({
      packageJson: manifest({ preview: true, version: "0.3.0" }),
      releaseTag: "v0.3.0"
    }).channel,
    "preview"
  );
});

test("binds a clean canonical tag checkout to its immutable package bytes", (context) => {
  const root = repository(context);
  const receipt = readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: root });
  assert.equal(receipt.channel, "stable");
  assert.equal(receipt.branch, "main");
  assert.equal(receipt.commit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(receipt.version, "1.0.1");

  git(root, ["remote", "set-url", "origin", "https://github.com/Matt17BR/openwrangler"]);
  assert.equal(readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: root }).commit, receipt.commit);

  const previewRoot = repository(context, manifest({ preview: true, version: "1.99.0" }));
  const preview = readRegistryReleaseSource({ releaseTag: "v1.99.0", sourceRoot: previewRoot });
  assert.equal(preview.branch, "main");
  assert.equal(preview.channel, "preview");
});

test("rejects wrong identities, moved tags, dirty sources, and noncanonical origins", (context) => {
  assert.notDeepEqual(
    inspectRegistryReleaseManifest({
      packageJson: manifest().replace("Matt17BR", "someone"),
      releaseTag: "v1.0.1"
    }).problems,
    []
  );

  const moved = repository(context);
  writeFileSync(join(moved, "package.json"), `${manifest()}\n`, "utf8");
  git(moved, ["commit", "--quiet", "-am", "later"]);
  assert.throws(
    () => readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: moved }),
    /exact lightweight ref at the release source commit/u
  );

  const dirty = repository(context);
  writeFileSync(join(dirty, "package.json"), `${manifest()}\n`, "utf8");
  assert.throws(
    () => readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: dirty }),
    /modified tracked files/u
  );

  const wrongOrigin = repository(context);
  git(wrongOrigin, ["remote", "set-url", "origin", "https://example.com/other.git"]);
  assert.throws(
    () => readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: wrongOrigin }),
    /canonical public GitHub origin/u
  );
});

test("rejects annotated tags and current releases outside protected main", (context) => {
  const annotated = repository(context);
  git(annotated, ["tag", "--delete", "v1.0.1"]);
  git(annotated, ["tag", "--annotate", "v1.0.1", "--message", "annotated"]);
  assert.throws(
    () => readRegistryReleaseSource({ releaseTag: "v1.0.1", sourceRoot: annotated }),
    /exact lightweight ref/u
  );

  const offBranch = repository(context, manifest({ version: "1.2.3" }));
  const releaseCommit = git(offBranch, ["rev-parse", "HEAD"]);
  git(offBranch, ["checkout", "--quiet", "--orphan", "unrelated"]);
  git(offBranch, ["rm", "--quiet", "--cached", "package.json"]);
  writeFileSync(join(offBranch, "package.json"), manifest({ version: "1.2.3" }), "utf8");
  git(offBranch, ["add", "package.json"]);
  git(offBranch, ["commit", "--quiet", "-m", "unrelated"]);
  const unrelatedCommit = git(offBranch, ["rev-parse", "HEAD"]);
  git(offBranch, ["checkout", "--quiet", "--detach", releaseCommit]);
  git(offBranch, ["update-ref", "refs/remotes/origin/main", unrelatedCommit]);
  assert.throws(
    () => readRegistryReleaseSource({ releaseTag: "v1.2.3", sourceRoot: offBranch }),
    /protected main branch/u
  );
});

test("allows immutable releases through v1.2.2 to be recovered from their tag", (context) => {
  const root = repository(context, manifest({ version: "1.2.2" }));
  git(root, ["update-ref", "-d", "refs/remotes/origin/main"]);
  const receipt = readRegistryReleaseSource({ releaseTag: "v1.2.2", sourceRoot: root });
  assert.equal(receipt.branch, "main");
  assert.equal(receipt.version, "1.2.2");
});
