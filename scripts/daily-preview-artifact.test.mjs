import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  dailyPreviewReleaseNotes,
  inspectDailyPreviewSourceCommit,
  prepareDailyPreviewCommit
} from "./daily-preview-artifact.mjs";
import {
  classifyNumericReleaseVersion,
  dailyPreviewVersionFromDate,
  inspectReleaseMetadata
} from "./release-metadata.mjs";
import { readRegistryReleaseSource } from "./registry-release-source.mjs";
import { readPreviewReleaseNotesFromCommit } from "./publish-github-preview-release.mjs";

const fixtureRoot = resolve(import.meta.dirname, "..");

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-27T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-27T00:00:00Z"
    }
  }).trim();
}

function repository(context) {
  const root = mkdtempSync(join(tmpdir(), "ow-daily-preview-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  for (const path of ["package.json", "package-lock.json", "python/openwrangler_runtime/version.py"]) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(fixtureRoot, path), destination, { recursive: true });
  }
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "source"]);
  return root;
}

test("daily preview dates are exact and manual 1.99 previews stop at 1.99.7", () => {
  assert.equal(dailyPreviewVersionFromDate("20260828"), "1.99.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260229"), undefined);
  assert.equal(classifyNumericReleaseVersion("1.99.8"), undefined);
  assert.equal(classifyNumericReleaseVersion("2.0.0")?.channel, "stable");
  const packageJson = (version) => JSON.stringify({ name: "openwrangler", preview: true, version });
  assert.deepEqual(inspectReleaseMetadata({ packageJson: packageJson("1.99.7"), releaseTag: "v1.99.7" }).problems, []);
  assert.match(
    inspectReleaseMetadata({ packageJson: packageJson("1.99.8"), releaseTag: "v1.99.8" }).problems.join(" "),
    /end at 1\.99\.7/u
  );
});

test("daily preview preparation is deterministic and changes only version sources", (context) => {
  const firstRoot = repository(context);
  const secondRoot = repository(context);
  const sourceSha = git(firstRoot, ["rev-parse", "HEAD"]);
  assert.equal(git(secondRoot, ["rev-parse", "HEAD"]), sourceSha);
  const environment = {
    GITHUB_REF: "refs/heads/main",
    PREVIEW_DATE: "20260828",
    SOURCE_SHA: sourceSha
  };
  const first = prepareDailyPreviewCommit({ environment, root: firstRoot });
  const second = prepareDailyPreviewCommit({ environment, root: secondRoot });
  assert.equal(second.generatedSha, first.generatedSha);
  assert.equal(JSON.parse(readFileSync(join(firstRoot, "package.json"), "utf8")).version, "1.99.20260828");
  assert.match(dailyPreviewReleaseNotes({ sourceSha, version: first.version }), /2026-08-28/u);
  assert.match(
    readPreviewReleaseNotesFromCommit({
      commit: first.generatedSha,
      releaseTag: first.releaseTag,
      root: firstRoot,
      version: first.version
    }),
    /stable VS Code/u
  );
  assert.equal(
    inspectDailyPreviewSourceCommit({
      commit: first.generatedSha,
      expectedParent: sourceSha,
      releaseTag: first.releaseTag,
      root: firstRoot
    }).parentCommit,
    sourceSha
  );
  git(firstRoot, ["remote", "add", "origin", "https://github.com/Matt17BR/openwrangler.git"]);
  git(firstRoot, ["update-ref", "refs/remotes/origin/main", sourceSha]);
  git(firstRoot, ["tag", first.releaseTag, first.generatedSha]);
  assert.equal(
    readRegistryReleaseSource({ releaseTag: first.releaseTag, sourceRoot: firstRoot }).commit,
    first.generatedSha
  );
  writeFileSync(join(firstRoot, "unexpected.txt"), "unexpected\n");
  git(firstRoot, ["add", "unexpected.txt"]);
  git(firstRoot, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "--amend",
    "--no-edit"
  ]);
  assert.throws(
    () =>
      inspectDailyPreviewSourceCommit({
        commit: git(firstRoot, ["rev-parse", "HEAD"]),
        releaseTag: first.releaseTag,
        root: firstRoot
      }),
    /only its three version files/u
  );
});
