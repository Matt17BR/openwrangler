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
  dailyPreviewDateFromVersion,
  dailyPreviewVersionFromDate,
  inspectReleaseMetadata,
  isDailyPreviewVersion
} from "./release-metadata.mjs";
import { readRegistryReleaseSource } from "./registry-release-source.mjs";
import { readPreviewReleaseNotesFromCommit } from "./publish-github-preview-release.mjs";

const fixtureRoot = resolve(import.meta.dirname, "..");
const versionPaths = ["package.json", "package-lock.json", "python/openwrangler_runtime/version.py"];

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

function writeVersionSources(root, { preview, version }) {
  const packageJsonPath = join(root, "package.json");
  const packageLockPath = join(root, "package-lock.json");
  const runtimeVersionPath = join(root, "python/openwrangler_runtime/version.py");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const packageLock = JSON.parse(readFileSync(packageLockPath, "utf8"));
  const runtimeVersion = readFileSync(runtimeVersionPath, "utf8");
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, preview, version }, null, 2)}\n`);
  writeFileSync(
    packageLockPath,
    `${JSON.stringify(
      {
        ...packageLock,
        version,
        packages: { ...packageLock.packages, "": { ...packageLock.packages[""], version } }
      },
      null,
      2
    )}\n`
  );
  writeFileSync(runtimeVersionPath, runtimeVersion.replace(/^__version__ = "[^"]+"$/mu, `__version__ = "${version}"`));
}

function repository(context, metadata = { preview: true, version: "1.99.7" }) {
  const root = mkdtempSync(join(tmpdir(), "ow-daily-preview-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  for (const path of versionPaths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(fixtureRoot, path), destination, { recursive: true });
  }
  writeVersionSources(root, metadata);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "source"]);
  return root;
}

test("daily preview series preserves pre-v2 compatibility and follows stable-series rollovers", () => {
  assert.equal(dailyPreviewVersionFromDate("20260828", "1.99.7"), "1.99.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260828", "1.2.9"), "1.99.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260229", "2.0.0"), undefined);
  assert.equal(dailyPreviewDateFromVersion("2.0.20260229"), undefined);
  assert.equal(isDailyPreviewVersion("2.0.20260229"), false);
  assert.equal(dailyPreviewVersionFromDate("20260828", "2.0.4"), "2.0.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260828", "2.0.20260828"), undefined);
  assert.equal(dailyPreviewVersionFromDate("20260828", "2.1.0"), "2.1.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260828", "12.34.5"), "12.34.20260828");
  assert.equal(dailyPreviewVersionFromDate("20260828", "2.1.99999999"), undefined);
  assert.equal(dailyPreviewDateFromVersion("2.1.20260828"), "20260828");
  assert.equal(isDailyPreviewVersion("12.34.20260828"), true);
  assert.equal(isDailyPreviewVersion("1.2.20260828"), false);
  assert.equal(isDailyPreviewVersion("0.3.20260828"), false);
  assert.equal(classifyNumericReleaseVersion("2.0.20260828")?.channel, "preview");
  assert.equal(classifyNumericReleaseVersion("2.1.20260828")?.channel, "preview");
  assert.equal(classifyNumericReleaseVersion("1.2.20260828")?.channel, "stable");
  assert.equal(classifyNumericReleaseVersion("0.2.20260828")?.channel, "stable");
  assert.equal(classifyNumericReleaseVersion("2.0.20260229")?.channel, "stable");
  for (let patch = 0; patch <= 7; patch += 1) {
    assert.equal(classifyNumericReleaseVersion(`1.99.${patch}`)?.channel, "preview");
  }
  assert.equal(classifyNumericReleaseVersion("1.99.8"), undefined);
  assert.equal(classifyNumericReleaseVersion("2.0.0")?.channel, "stable");
  const packageJson = (version) => JSON.stringify({ name: "openwrangler", preview: true, version });
  assert.deepEqual(inspectReleaseMetadata({ packageJson: packageJson("1.99.7"), releaseTag: "v1.99.7" }).problems, []);
  assert.match(
    inspectReleaseMetadata({ packageJson: packageJson("1.99.8"), releaseTag: "v1.99.8" }).problems.join(" "),
    /end at 1\.99\.7/u
  );
});

test("pre-v2 source preparation retains the 1.99 compatibility series", (context) => {
  const root = repository(context);
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const result = prepareDailyPreviewCommit({
    environment: {
      GITHUB_REF: "refs/heads/main",
      PREVIEW_DATE: "20260828",
      SOURCE_SHA: sourceSha
    },
    root
  });
  assert.equal(result.version, "1.99.20260828");
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, result.version);
  assert.equal(
    inspectDailyPreviewSourceCommit({
      commit: result.generatedSha,
      expectedParent: sourceSha,
      releaseTag: result.releaseTag,
      root
    }).version,
    result.version
  );
});

test("stable-series preparation is deterministic, recoverable, and changes only version sources", (context) => {
  const metadata = { preview: false, version: "2.0.4" };
  const firstRoot = repository(context, metadata);
  const secondRoot = repository(context, metadata);
  const mismatchedRoot = repository(context, metadata);
  const sourceSha = git(firstRoot, ["rev-parse", "HEAD"]);
  assert.equal(git(secondRoot, ["rev-parse", "HEAD"]), sourceSha);
  const environment = {
    GITHUB_REF: "refs/heads/main",
    PREVIEW_DATE: "20260828",
    SOURCE_SHA: sourceSha
  };
  const first = prepareDailyPreviewCommit({ environment, root: firstRoot });
  const second = prepareDailyPreviewCommit({
    environment: { ...environment, EXPECTED_GENERATED_SHA: first.generatedSha },
    root: secondRoot
  });
  assert.throws(
    () =>
      prepareDailyPreviewCommit({
        environment: { ...environment, EXPECTED_GENERATED_SHA: sourceSha },
        root: mismatchedRoot
      }),
    /reconstructed daily preview commit differs from the qualified source commit/u
  );
  assert.equal(second.generatedSha, first.generatedSha);
  assert.equal(first.version, "2.0.20260828");
  assert.equal(JSON.parse(readFileSync(join(firstRoot, "package.json"), "utf8")).version, first.version);
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

test("source inspection rejects a wrong-series child after a stable-series rollover", (context) => {
  const root = repository(context, { preview: false, version: "2.1.3" });
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const result = prepareDailyPreviewCommit({
    environment: {
      GITHUB_REF: "refs/heads/main",
      PREVIEW_DATE: "20260828",
      SOURCE_SHA: sourceSha
    },
    root
  });
  assert.equal(result.version, "2.1.20260828");

  const wrongVersion = "2.0.20260828";
  writeVersionSources(root, { preview: true, version: wrongVersion });
  git(root, ["add", "--", ...versionPaths]);
  git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--amend", "--no-edit"]);
  assert.throws(
    () =>
      inspectDailyPreviewSourceCommit({
        commit: git(root, ["rev-parse", "HEAD"]),
        expectedParent: sourceSha,
        releaseTag: `v${wrongVersion}`,
        root
      }),
    /series does not match its protected-main source/u
  );
});
