import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { load as parseYaml } from "js-yaml";
import {
  dailyPreviewReleaseNotes,
  inspectDailyPreviewSourceCommit,
  prepareDailyPreviewCommit,
  readDailyPreviewSourceChanges,
  renderDailyPreviewReleaseNotes
} from "./daily-preview-artifact.mjs";
import {
  classifyNumericReleaseVersion,
  dailyPreviewDateFromVersion,
  dailyPreviewVersionFromDate,
  inspectReleaseMetadata,
  isDailyPreviewVersion
} from "./release-metadata.mjs";
import { readRegistryReleaseSource } from "./registry-release-source.mjs";
import {
  prepareDailyPreviewNotesBaseline,
  readPreviewReleaseNotesFromCommit
} from "./publish-github-preview-release.mjs";

const fixtureRoot = resolve(import.meta.dirname, "..");
const versionPaths = ["package.json", "package-lock.json", "python/openwrangler_runtime/version.py"];

const scheduledSource = "a".repeat(40);
for (const scenario of [
  { name: "unchanged source", previous: scheduledSource, build: false },
  { name: "changed source", previous: "b".repeat(40), build: true },
  { name: "no successful history", previous: "", build: true },
  { name: "retired manual request", previous: scheduledSource, event: "workflow_dispatch" },
  { name: "history lookup failure", previous: "", apiStatus: 1 },
  { name: "malformed history source", previous: "invalid" },
  { name: "non-main request", previous: scheduledSource, ref: "refs/heads/other" }
]) {
  test(`scheduled preview decision: ${scenario.name}`, { skip: process.platform === "win32" }, (context) => {
    const workflow = parseYaml(readFileSync(join(fixtureRoot, ".github/workflows/preview-release.yml"), "utf8"));
    const check = workflow.jobs.changes;
    const script = check.steps.find((step) => step.id === "source").run;
    assert.equal(check.outputs.build, "${{ steps.source.outputs.build }}");
    assert.equal(workflow.jobs.package.needs, "changes");
    assert.equal(workflow.jobs.package.if, "${{ needs.changes.outputs.build == 'true' }}");
    const root = mkdtempSync(join(tmpdir(), "ow-preview-decision-"));
    context.after(() => rmSync(root, { recursive: true, force: true }));
    const output = join(root, "output");
    const summary = join(root, "summary");
    const argumentsPath = join(root, "gh-arguments");
    writeFileSync(
      join(root, "gh"),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_GH_ARGUMENTS"\nprintf "%s" "$TEST_PREVIOUS_SHA"\nexit "$TEST_GH_STATUS"\n',
      { mode: 0o755 }
    );
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        EVENT_NAME: scenario.event ?? "schedule",
        EVENT_REF: scenario.ref ?? "refs/heads/main",
        SOURCE_SHA: scheduledSource,
        RUN_REPOSITORY: "Matt17BR/openwrangler",
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        TEST_GH_ARGUMENTS: argumentsPath,
        TEST_PREVIOUS_SHA: scenario.previous,
        TEST_GH_STATUS: String(scenario.apiStatus ?? 0)
      }
    });
    assert.ifError(result.error);
    if (scenario.build === undefined) {
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(output), false);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), `build=${scenario.build}\n`);
      assert.match(readFileSync(summary, "utf8"), scenario.build ? /Building/u : /Skipping preview build/u);
    }
    if (scenario.event === "workflow_dispatch" || scenario.ref !== undefined) {
      assert.equal(existsSync(argumentsPath), false);
    } else {
      assert.deepEqual(readFileSync(argumentsPath, "utf8").trim().split("\n"), [
        "api",
        "--method",
        "GET",
        "repos/Matt17BR/openwrangler/actions/workflows/preview-release.yml/runs?event=schedule&status=success&branch=main&per_page=1",
        "--jq",
        '.workflow_runs[0].head_sha // ""'
      ]);
    }
  });
}

for (const scenario of [
  { name: "first attempt", attempt: "1", allowed: true },
  { name: "second attempt", attempt: "2" },
  { name: "later attempt", attempt: "9" },
  { name: "missing attempt" },
  { name: "empty attempt", attempt: "" },
  { name: "noncanonical attempt", attempt: "01" },
  { name: "malformed attempt", attempt: "1x" }
]) {
  test(`preview package admission: ${scenario.name}`, { skip: process.platform === "win32" }, () => {
    const workflow = parseYaml(readFileSync(join(fixtureRoot, ".github/workflows/preview-release.yml"), "utf8"));
    const steps = workflow.jobs.package.steps;
    const checkoutIndex = steps.findIndex((step) => step.uses?.startsWith("actions/checkout@"));
    assert.notEqual(checkoutIndex, -1);
    const script = steps
      .slice(0, checkoutIndex)
      .map((step) => step.run ?? "")
      .join("\n");
    const environment = { ...process.env };
    delete environment.RUN_ATTEMPT;
    if (scenario.attempt !== undefined) environment.RUN_ATTEMPT = scenario.attempt;
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], {
      encoding: "utf8",
      timeout: 10_000,
      env: environment
    });
    assert.ifError(result.error);
    if (scenario.allowed) {
      assert.equal(result.status, 0, result.stderr);
    } else {
      assert.notEqual(result.status, 0, "Packaging must refuse this attempt before checkout or installation.");
    }
    assert.ok(checkoutIndex > 0, "The attempt guard must precede checkout.");
    assert.equal(typeof steps[0].run, "string");
    assert.equal(steps[0].env.RUN_ATTEMPT, "${{ github.run_attempt }}");
  });
}

function git(root, args) {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
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

function tagStable(root, version, commit = "HEAD", annotated = false) {
  const arguments_ = annotated
    ? ["tag", "-a", "-m", `Stable ${version}`, `v${version}`, commit]
    : ["tag", `v${version}`, commit];
  git(root, arguments_);
}

function repository(
  context,
  {
    source = { preview: true, version: "1.99.7" },
    stable = { preview: false, version: "1.2.0" },
    stableTagAnnotated = false
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "ow-daily-preview-"));
  context.after(() => rmSync(root, { force: true, recursive: true }));
  for (const path of versionPaths) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(join(fixtureRoot, path), destination, { recursive: true });
  }
  const initial = stable ?? source;
  writeVersionSources(root, initial);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "initial"]);
  if (stable !== null) tagStable(root, stable.version, "HEAD", stableTagAnnotated);
  if (source.preview !== initial.preview || source.version !== initial.version) {
    writeVersionSources(root, source);
    git(root, ["add", ...versionPaths]);
    git(root, ["commit", "--quiet", "-m", "source"]);
  }
  return root;
}

function commitChanges(root, subject) {
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", subject]);
  return git(root, ["rev-parse", "HEAD"]);
}

test("daily notes link complete source subjects and identify the first preview's stable comparison", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "grid.txt"), "change\n");
  const sourceSha = commitChanges(root, "Keep [Code Preview] & <grid> ~readable~");
  const notes = dailyPreviewReleaseNotes({ root, baseSha, baseTag: "v2.1.0", sourceSha, version: "2.1.20260910" });
  assert.match(notes, /No earlier published preview/u);
  assert.ok(
    notes.includes(
      `- [Keep \\[Code Preview\\] &amp; &lt;grid&gt; \\~readable\\~](https://github.com/Matt17BR/openwrangler/commit/${sourceSha})`
    )
  );
  assert.ok(
    notes.includes(`[Full comparison](https://github.com/Matt17BR/openwrangler/compare/${baseSha}...${sourceSha})`)
  );
  assert.equal(notes.includes("# Open Wrangler"), false);
  assert.equal(notes.includes("VSIX"), false);
});

test("daily notes group frozen PRs and fold only changes after the first five", (context) => {
  const root = repository(context);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v1.99.7", baseSha]);
  const commits = [];
  for (let index = 0; index < 8; index += 1) {
    writeFileSync(join(root, "grid.txt"), `change ${index}\n`);
    commits.push(commitChanges(root, `Change ${index}`));
  }
  const notes = dailyPreviewReleaseNotes({
    baseSha,
    baseTag: "v1.99.7",
    root,
    sourceSha: commits.at(-1),
    version: "1.99.20260910",
    pullRequests: [{ number: 41, title: "Fix [grid] & <rows> *again* ~~literally~~", commits: commits.slice(0, 2) }]
  });
  assert.ok(
    notes.startsWith(
      "Changes since the previous preview, [v1.99.7](https://github.com/Matt17BR/openwrangler/releases/tag/v1.99.7).\n\n"
    )
  );
  const [visible, folded] = notes.split("<details>\n<summary>Read more: 2 more changes</summary>\n\n");
  assert.equal(visible.split("\n").filter((line) => line.startsWith("- ")).length, 5);
  assert.ok(folded, notes);
  assert.equal(folded.split("\n").filter((line) => line.startsWith("- ")).length, 2);
  assert.ok(
    folded.includes(
      "- [Fix \\[grid\\] &amp; &lt;rows&gt; \\*again\\* \\~\\~literally\\~\\~ (#41)](https://github.com/Matt17BR/openwrangler/pull/41)"
    )
  );
  assert.equal(notes.includes(`commit/${commits[0]}`), false);
  assert.equal(notes.includes(`commit/${commits[1]}`), false);
  for (const commit of commits.slice(2)) assert.ok(notes.includes(`commit/${commit}`));
  assert.equal(visible.includes("Full comparison"), false);
  assert.ok(
    folded.endsWith(
      `[Full comparison](https://github.com/Matt17BR/openwrangler/compare/${baseSha}...${commits.at(-1)})\n\n</details>\n`
    )
  );
  assert.equal(notes.includes("<details open"), false);
});

test("daily notes leave five changes unfolded and link the first-preview stable fallback", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  let sourceSha = baseSha;
  for (let index = 0; index < 5; index += 1) {
    writeFileSync(join(root, "grid.txt"), `change ${index}\n`);
    sourceSha = commitChanges(root, `Change ${index}`);
  }
  const notes = dailyPreviewReleaseNotes({ root, baseSha, baseTag: "v2.1.0", sourceSha, version: "2.1.20260910" });
  assert.ok(
    notes.startsWith(
      "No earlier published preview; changes since stable [v2.1.0](https://github.com/Matt17BR/openwrangler/releases/tag/v2.1.0).\n\n"
    )
  );
  assert.equal(notes.split("\n").filter((line) => line.startsWith("- ")).length, 5);
  assert.equal(notes.includes("<details>"), false);
  assert.ok(
    notes.endsWith(`[Full comparison](https://github.com/Matt17BR/openwrangler/compare/${baseSha}...${sourceSha})\n`)
  );
  writeFileSync(join(root, "grid.txt"), "sixth change\n");
  sourceSha = commitChanges(root, "Sixth change");
  const longer = dailyPreviewReleaseNotes({ root, baseSha, baseTag: "v2.1.0", sourceSha, version: "2.1.20260910" });
  assert.ok(longer.includes("<summary>Read more: 1 more change</summary>"));
  assert.equal(
    longer
      .split("<details>")[0]
      .split("\n")
      .filter((line) => line.startsWith("- ")).length,
    5
  );
});

test("daily notes reject malformed, oversized or out-of-range frozen PR attribution", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "grid.txt"), "change\n");
  const sourceSha = commitChanges(root, "Preserve this direct change");
  const source = readDailyPreviewSourceChanges({
    root,
    baseSha,
    baseTag: "v2.1.0",
    sourceSha,
    version: "2.1.20260910"
  });
  const valid = { number: 41, title: "Reviewed change", commits: [sourceSha] };
  for (const value of [
    undefined,
    null,
    {},
    [null],
    [{ ...valid, number: 0 }],
    [{ ...valid, number: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...valid, title: " " }],
    [{ ...valid, title: "title\nnext line" }],
    [{ ...valid, title: "x".repeat(64 * 1024) }],
    [{ ...valid, commits: [] }],
    [{ ...valid, commits: [baseSha] }],
    [{ ...valid, commits: [sourceSha, sourceSha] }],
    [valid, valid],
    [valid, { ...valid, number: 42 }],
    [{ ...valid, url: "https://unrelated.invalid" }]
  ]) {
    assert.throws(() => renderDailyPreviewReleaseNotes(source, value), /Daily preview PR attribution/u);
  }
  assert.ok(renderDailyPreviewReleaseNotes(source, []).includes(`commit/${sourceSha}`));
  assert.ok(renderDailyPreviewReleaseNotes(source, [valid]).includes("pull/41"));
});

test("daily notes omit proven version-only metadata and retain dependency and mixed changes", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  writeVersionSources(root, { preview: false, version: "2.1.1" });
  const versionCommit = commitChanges(root, "Prepare Open Wrangler 2.1.1 release metadata");
  assert.match(
    dailyPreviewReleaseNotes({ root, baseSha, baseTag: "v2.1.0", sourceSha: versionCommit, version: "2.1.20260910" }),
    /No source changes beyond release metadata/u
  );
  writeVersionSources(root, { preview: false, version: "2.1.2" });
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  manifest.scripts.example = "node example.mjs";
  writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const dependencyCommit = commitChanges(root, "Prepare a version with changed configuration");
  writeVersionSources(root, { preview: false, version: "2.1.3" });
  writeFileSync(join(root, "grid.txt"), "mixed change\n");
  const mixedCommit = commitChanges(root, "Fix preview behavior with a version change");
  writeVersionSources(root, { preview: false, version: "2.1.4" });
  writeFileSync(join(root, "CHANGELOG.md"), "A curated correction\n");
  const sourceSha = commitChanges(root, "Keep curated release notes visible");
  const notes = dailyPreviewReleaseNotes({ root, baseSha, baseTag: "v2.1.0", sourceSha, version: "2.1.20260910" });
  assert.equal(notes.includes(versionCommit), false);
  assert.ok(notes.includes(dependencyCommit));
  assert.ok(
    notes.includes(
      `- [Keep curated release notes visible](https://github.com/Matt17BR/openwrangler/commit/${sourceSha})`
    )
  );
  assert.ok(
    notes.includes(
      `- [Fix preview behavior with a version change](https://github.com/Matt17BR/openwrangler/commit/${mixedCommit})`
    )
  );
});

test("daily notes normalize sibling preview commits and keep the frozen source range on retry", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const firstSource = git(root, ["rev-parse", "HEAD"]);
  const previous = prepareDailyPreviewCommit({
    root,
    environment: { GITHUB_REF: "refs/heads/main", SOURCE_SHA: firstSource, PREVIEW_DATE: "20260828" }
  });
  git(root, ["tag", previous.releaseTag, previous.generatedSha]);
  git(root, ["checkout", "--quiet", firstSource]);
  writeFileSync(join(root, "grid.txt"), "visible change\n");
  const currentSource = commitChanges(root, "Preserve grid focus");
  const current = prepareDailyPreviewCommit({
    root,
    environment: { GITHUB_REF: "refs/heads/main", SOURCE_SHA: currentSource, PREVIEW_DATE: "20260829" }
  });
  const input = {
    baseTag: previous.releaseTag,
    baseSha: previous.generatedSha,
    commit: current.generatedSha,
    pullRequests: [],
    releaseTag: current.releaseTag,
    root,
    version: current.version
  };
  const notes = readPreviewReleaseNotesFromCommit(input);
  assert.equal(
    notes,
    `Changes since the previous preview, [${previous.releaseTag}](https://github.com/Matt17BR/openwrangler/releases/tag/${previous.releaseTag}).\n\n- [Preserve grid focus](https://github.com/Matt17BR/openwrangler/commit/${currentSource})\n\n[Full comparison](https://github.com/Matt17BR/openwrangler/compare/${firstSource}...${currentSource})\n`
  );
  writeFileSync(join(root, "later.txt"), "future source\n");
  commitChanges(root, "A later change");
  assert.equal(readPreviewReleaseNotesFromCommit(input), notes);
  assert.throws(
    () => readPreviewReleaseNotesFromCommit({ ...input, pullRequests: undefined }),
    /frozen PR attribution/u
  );
  assert.throws(() => readPreviewReleaseNotesFromCommit({ ...input, baseSha: undefined }), /baseline commits/u);
  assert.throws(() => readPreviewReleaseNotesFromCommit({ ...input, baseTag: undefined }), /baseline commits/u);
  git(root, ["tag", "--force", previous.releaseTag, current.generatedSha]);
  assert.throws(() => readPreviewReleaseNotesFromCommit(input), /baseline tag moved/u);
});

test("first-preview preparation freezes the bound stable baseline and distinguishes lookup failure", async (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const current = prepareDailyPreviewCommit({
    root,
    environment: { GITHUB_REF: "refs/heads/main", SOURCE_SHA: sourceSha, PREVIEW_DATE: "20260829" }
  });
  const options = {
    commit: current.generatedSha,
    releaseTag: current.releaseTag,
    root,
    repository: "Matt17BR/openwrangler",
    token: "test-token"
  };
  const baseline = await prepareDailyPreviewNotesBaseline({
    ...options,
    fetchImpl: async (_url, input) => {
      assert.equal(input.method, undefined);
      return new Response("[]");
    }
  });
  assert.deepEqual(baseline, { baseTag: current.stableTag, baseSha: sourceSha, pullRequests: [] });
  const notes = readPreviewReleaseNotesFromCommit({ ...options, ...baseline, version: current.version });
  assert.match(notes, /No earlier published preview/u);
  assert.match(notes, /No source changes beyond release metadata/u);
  await assert.rejects(
    prepareDailyPreviewNotesBaseline({ ...options, fetchImpl: async () => new Response("{}", { status: 503 }) }),
    /HTTP 503/u
  );
});

test("package preparation freezes PR titles from the complete range before filtering version-only commits", async (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  writeFileSync(join(root, "grid.txt"), "change\n");
  const productCommit = commitChanges(root, "Product change without a PR suffix");
  writeVersionSources(root, { preview: false, version: "2.1.1" });
  const versionCommit = commitChanges(root, "Version-only merge result");
  const current = prepareDailyPreviewCommit({
    root,
    environment: { GITHUB_REF: "refs/heads/main", SOURCE_SHA: versionCommit, PREVIEW_DATE: "20260829" }
  });
  const requests = [];
  const options = {
    commit: current.generatedSha,
    releaseTag: current.releaseTag,
    root,
    repository: "Matt17BR/openwrangler",
    token: "test-token"
  };
  const frozen = await prepareDailyPreviewNotesBaseline({
    ...options,
    fetchImpl: async (url, input) => {
      requests.push(url);
      if (url.includes("/releases?")) return new Response("[]");
      assert.equal(url, "https://api.github.com/graphql");
      assert.equal(input.method, "POST");
      const query = JSON.parse(input.body).query;
      const commits = [...query.matchAll(/object\(oid: "([0-9a-f]{40})"\)/gu)].map((match) => match[1]);
      assert.deepEqual(commits, [versionCommit, productCommit]);
      return Response.json({
        data: {
          repository: {
            nameWithOwner: options.repository,
            ...Object.fromEntries(
              commits.map((commit, index) => [
                `c${index}`,
                {
                  oid: commit,
                  associatedPullRequests: {
                    pageInfo: { hasNextPage: false },
                    nodes: [
                      {
                        number: 41,
                        title: "Frozen [reviewed] title",
                        state: "MERGED",
                        baseRefName: "main",
                        repository: { nameWithOwner: options.repository },
                        baseRepository: { nameWithOwner: options.repository },
                        mergeCommit: { oid: versionCommit }
                      }
                    ]
                  }
                }
              ])
            )
          }
        }
      });
    }
  });
  assert.deepEqual(frozen.pullRequests, [
    { number: 41, title: "Frozen [reviewed] title", commits: [versionCommit, productCommit] }
  ]);
  const input = { ...options, ...frozen, version: current.version };
  const notes = readPreviewReleaseNotesFromCommit(input);
  assert.equal(notes.split("\n").filter((line) => line.startsWith("- ")).length, 1);
  assert.ok(notes.includes("- [Frozen \\[reviewed\\] title (#41)](https://github.com/Matt17BR/openwrangler/pull/41)"));
  assert.equal(notes.includes(`commit/${productCommit}`), false);
  assert.equal(notes.includes(`commit/${versionCommit}`), false);
  writeFileSync(join(root, "later.txt"), "later change\n");
  commitChanges(root, "Later source is outside the frozen publication");
  assert.equal(
    readPreviewReleaseNotesFromCommit({ ...input, pullRequests: JSON.parse(JSON.stringify(frozen.pullRequests)) }),
    notes
  );
  assert.equal(requests.length, 2);
});

test("daily notes preserve merge-resolution commits and refuse oversized complete notes", (context) => {
  const metadata = { preview: false, version: "2.1.0" };
  const root = repository(context, { source: metadata, stable: metadata });
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "--quiet", "-b", "side"]);
  writeFileSync(join(root, "side.txt"), "side\n");
  commitChanges(root, "Side change");
  git(root, ["checkout", "--quiet", "--detach", baseSha]);
  writeFileSync(join(root, "main.txt"), "main\n");
  commitChanges(root, "Main change");
  git(root, ["merge", "--no-commit", "--no-ff", "side"]);
  writeFileSync(join(root, "resolution.txt"), "merge-only result\n");
  const merged = commitChanges(root, "Resolve the combined grid behavior");
  const input = { baseSha, baseTag: "v2.1.0", root, sourceSha: merged, version: "2.1.20260910" };
  assert.ok(dailyPreviewReleaseNotes(input).includes(`commit/${merged}`));
  const messagePath = join(root, ".git", "notes-message");
  writeFileSync(messagePath, "x".repeat(70 * 1024));
  git(root, ["commit", "--quiet", "--allow-empty", "-F", messagePath]);
  const oversized = git(root, ["rev-parse", "HEAD"]);
  assert.throws(() => dailyPreviewReleaseNotes({ ...input, sourceSha: oversized }), /Release notes must be/u);
});

test("daily notes retain manual preview bases and reject nonancestor source ranges", (context) => {
  const root = repository(context);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  git(root, ["tag", "v1.99.7", baseSha]);
  writeFileSync(join(root, "grid.txt"), "change\n");
  const sourceSha = commitChanges(root, "Improve viewing");
  const input = { baseSha, baseTag: "v1.99.7", root, sourceSha, version: "1.99.20260910" };
  assert.ok(dailyPreviewReleaseNotes(input).includes(`/compare/${baseSha}...${sourceSha}`));
  writeVersionSources(root, { preview: false, version: "2.0.0" });
  const future = commitChanges(root, "Future release");
  tagStable(root, "2.0.0");
  assert.throws(
    () => dailyPreviewReleaseNotes({ ...input, baseSha: future, baseTag: "v2.0.0" }),
    /must be an ancestor/u
  );
});

test("the first package attempt freezes notes inputs for publication-only recovery", () => {
  const workflow = parseYaml(readFileSync(join(fixtureRoot, ".github/workflows/preview-release.yml"), "utf8"));
  const steps = workflow.jobs.package.steps;
  const baselineIndex = steps.findIndex((step) => step.id === "notes_base");
  assert.ok(baselineIndex > steps.findIndex((step) => step.run === "npm ci --ignore-scripts"));
  assert.ok(baselineIndex < steps.findIndex((step) => step.name === "Package the preview VSIX once"));
  assert.deepEqual(Object.keys(workflow.on), ["schedule"]);
  for (const id of ["utc_date", "daily_source", "notes_base"]) {
    assert.equal(steps.find((step) => step.id === id).if, undefined);
  }
  assert.equal(workflow.jobs.package.outputs["candidate-sha"], "${{ steps.daily_source.outputs.generated_sha }}");
  assert.equal(workflow.jobs.package.outputs["release-tag"], "${{ steps.daily_source.outputs.release_tag }}");
  assert.equal(workflow.jobs.release.if, "${{ !cancelled() && needs.package.result == 'success' }}");
  const reconstruct = workflow.jobs.release.steps.find(
    (step) => step.name === "Reconstruct the qualified daily source"
  );
  assert.equal(reconstruct.if, undefined);
  assert.equal(reconstruct.run, "node scripts/daily-preview-artifact.mjs prepare");
  assert.deepEqual(reconstruct.env, {
    EXPECTED_GENERATED_SHA: "${{ needs.package.outputs.candidate-sha }}",
    GITHUB_REF: "refs/heads/main",
    PREVIEW_DATE: "${{ needs.package.outputs.preview-date }}",
    SOURCE_SHA: "${{ github.sha }}"
  });
  assert.equal(steps[baselineIndex].run, "node scripts/publish-github-preview-release.mjs --notes-baseline");
  assert.equal(workflow.jobs.package.outputs["notes-base-tag"], "${{ steps.notes_base.outputs.notes_base_tag }}");
  assert.equal(workflow.jobs.package.outputs["notes-base-sha"], "${{ steps.notes_base.outputs.notes_base_sha }}");
  assert.equal(
    workflow.jobs.package.outputs["notes-pull-requests"],
    "${{ steps.notes_base.outputs.notes_pull_requests }}"
  );
  assert.deepEqual(workflow.jobs.package.permissions, { actions: "read", contents: "read", "pull-requests": "read" });
  assert.deepEqual(workflow.permissions, { actions: "read", contents: "read" });
  const publication = workflow.jobs.release.steps.find(
    (step) => step.name === "Publish and verify the exact GitHub preview release"
  );
  assert.equal(publication.env.NOTES_BASE_TAG, "${{ needs.package.outputs.notes-base-tag }}");
  assert.equal(publication.env.NOTES_BASE_SHA, "${{ needs.package.outputs.notes-base-sha }}");
  assert.equal(publication.env.NOTES_PULL_REQUESTS, "${{ needs.package.outputs.notes-pull-requests }}");
  assert.deepEqual(workflow.jobs.release.permissions, { actions: "write", contents: "write" });
  assert.equal(
    workflow.jobs.release.steps.some((step) => step.run?.includes("--notes-baseline")),
    false
  );
});

test("manual preview notes remain the exact curated text from their source commit", (context) => {
  const root = repository(context);
  const notesDirectory = join(root, "docs", "release-notes");
  mkdirSync(notesDirectory, { recursive: true });
  const notesPath = join(notesDirectory, "1.99.7.md");
  const curated = "# Reviewed manual preview\n\nA deliberately curated explanation.\n";
  writeFileSync(notesPath, curated);
  const commit = commitChanges(root, "Review manual preview notes");
  writeFileSync(notesPath, "Uncommitted replacement\n");
  assert.equal(readPreviewReleaseNotesFromCommit({ commit, releaseTag: "v1.99.7", root, version: "1.99.7" }), curated);
});

test("daily preview series preserves pre-v2 compatibility and follows stable-tag rollovers", () => {
  assert.equal(dailyPreviewVersionFromDate("20260828", "1.99.7"), undefined);
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
  assert.equal(result.stableTag, "v1.2.0");
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

test("inspection retains exact previous-generator compatibility", (context) => {
  for (const fixture of [
    {
      options: {},
      stableTag: "v1.2.0",
      version: "1.99.20260828"
    },
    {
      options: {
        source: { preview: false, version: "2.0.4" },
        stable: { preview: false, version: "2.0.4" }
      },
      stableTag: "v2.0.4",
      version: "2.0.20260828"
    }
  ]) {
    const root = repository(context, fixture.options);
    const sourceSha = git(root, ["rev-parse", "HEAD"]);
    writeVersionSources(root, { preview: true, version: fixture.version });
    git(root, ["add", "--", ...versionPaths]);
    git(root, [
      "-c",
      "user.name=Open Wrangler Automation",
      "-c",
      "user.email=actions@users.noreply.github.com",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      `Prepare daily preview ${fixture.version}`
    ]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    const inspected = inspectDailyPreviewSourceCommit({
      commit,
      expectedParent: sourceSha,
      releaseTag: `v${fixture.version}`,
      root
    });

    assert.equal(inspected.version, fixture.version);
    assert.equal(inspected.stableTag, fixture.stableTag);
  }
});

test("stable-series preparation is deterministic, recoverable, and changes only version sources", (context) => {
  const metadata = { preview: false, version: "2.0.4" };
  const firstRoot = repository(context, { source: metadata, stable: metadata });
  const secondRoot = repository(context, { source: metadata, stable: metadata });
  const mismatchedRoot = repository(context, { source: metadata, stable: metadata });
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
  assert.equal(first.stableTag, "v2.0.4");
  assert.equal(JSON.parse(readFileSync(join(firstRoot, "package.json"), "utf8")).version, first.version);
  assert.match(
    dailyPreviewReleaseNotes({
      baseSha: first.stableCommit,
      baseTag: first.stableTag,
      root: firstRoot,
      sourceSha,
      version: first.version
    }),
    /Full comparison/u
  );
  assert.match(
    readPreviewReleaseNotesFromCommit({
      baseSha: first.stableCommit,
      baseTag: first.stableTag,
      commit: first.generatedSha,
      pullRequests: [],
      releaseTag: first.releaseTag,
      root: firstRoot,
      version: first.version
    }),
    /No earlier published preview/u
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
  git(firstRoot, ["commit", "--quiet", "--amend", "--no-edit"]);
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

test("source-ahead previews retain the latest stable series until its stable tag exists", (context) => {
  const source = { preview: false, version: "2.2.0" };
  const stable = { preview: false, version: "2.1.1" };
  const root = repository(context, { source, stable });
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
  assert.equal(result.stableTag, "v2.1.1");

  tagStable(root, source.version, sourceSha);
  const retained = inspectDailyPreviewSourceCommit({
    commit: result.generatedSha,
    expectedParent: sourceSha,
    releaseTag: result.releaseTag,
    root
  });
  assert.equal(retained.stableTag, "v2.1.1");

  const promotedRoot = repository(context, { source, stable });
  const promotedSourceSha = git(promotedRoot, ["rev-parse", "HEAD"]);
  assert.equal(promotedSourceSha, sourceSha);
  tagStable(promotedRoot, source.version, promotedSourceSha);
  const promoted = prepareDailyPreviewCommit({
    environment: {
      GITHUB_REF: "refs/heads/main",
      PREVIEW_DATE: "20260828",
      SOURCE_SHA: promotedSourceSha
    },
    root: promotedRoot
  });
  assert.equal(promoted.version, "2.2.20260828");
  assert.equal(promoted.stableTag, "v2.2.0");
  assert.ok(result.version.localeCompare(source.version, "en", { numeric: true }) < 0);
  assert.ok(source.version.localeCompare(promoted.version, "en", { numeric: true }) < 0);

  const recoveryRoot = repository(context, { source, stable });
  const recoverySourceSha = git(recoveryRoot, ["rev-parse", "HEAD"]);
  tagStable(recoveryRoot, source.version, recoverySourceSha);
  assert.throws(
    () =>
      prepareDailyPreviewCommit({
        environment: {
          EXPECTED_GENERATED_SHA: result.generatedSha,
          GITHUB_REF: "refs/heads/main",
          PREVIEW_DATE: "20260828",
          SOURCE_SHA: recoverySourceSha
        },
        root: recoveryRoot
      }),
    /reconstructed daily preview commit differs from the qualified source commit/u
  );

  const legacyWrongRoot = repository(context, { source, stable });
  const legacyWrongSource = git(legacyWrongRoot, ["rev-parse", "HEAD"]);
  const legacyWrongVersion = "2.2.20260828";
  writeVersionSources(legacyWrongRoot, { preview: true, version: legacyWrongVersion });
  git(legacyWrongRoot, ["add", "--", ...versionPaths]);
  git(legacyWrongRoot, [
    "-c",
    "user.name=Open Wrangler Automation",
    "-c",
    "user.email=actions@users.noreply.github.com",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    `Prepare daily preview ${legacyWrongVersion}`
  ]);
  assert.throws(
    () =>
      inspectDailyPreviewSourceCommit({
        commit: git(legacyWrongRoot, ["rev-parse", "HEAD"]),
        expectedParent: legacyWrongSource,
        releaseTag: `v${legacyWrongVersion}`,
        root: legacyWrongRoot
      }),
    /trailerless daily preview series does not match the latest stable release tag/u
  );
});

test("source inspection rejects a series that differs from its bound stable tag", (context) => {
  const source = { preview: false, version: "2.1.3" };
  const root = repository(context, {
    source,
    stable: { preview: false, version: "2.0.4" }
  });
  const sourceSha = git(root, ["rev-parse", "HEAD"]);
  const result = prepareDailyPreviewCommit({
    environment: {
      GITHUB_REF: "refs/heads/main",
      PREVIEW_DATE: "20260828",
      SOURCE_SHA: sourceSha
    },
    root
  });
  assert.equal(result.version, "2.0.20260828");

  const wrongVersion = "2.1.20260828";
  writeVersionSources(root, { preview: true, version: wrongVersion });
  git(root, ["add", "--", ...versionPaths]);
  git(root, [
    "commit",
    "--quiet",
    "--amend",
    "--no-gpg-sign",
    "-m",
    `Prepare daily preview ${wrongVersion}`,
    "-m",
    `Stable-Release-Tag: ${result.stableTag}\nStable-Release-Commit: ${result.stableCommit}`
  ]);
  assert.throws(
    () =>
      inspectDailyPreviewSourceCommit({
        commit: git(root, ["rev-parse", "HEAD"]),
        expectedParent: sourceSha,
        releaseTag: `v${wrongVersion}`,
        root
      }),
    /series does not match its bound stable release tag/u
  );
});

test("preparation rejects missing or malformed stable tag authority before writing", (context) => {
  const metadata = { preview: false, version: "2.0.4" };
  const missingRoot = repository(context, { source: metadata, stable: null });
  const missingHead = git(missingRoot, ["rev-parse", "HEAD"]);
  assert.throws(
    () =>
      prepareDailyPreviewCommit({
        environment: {
          GITHUB_REF: "refs/heads/main",
          PREVIEW_DATE: "20260828",
          SOURCE_SHA: missingHead
        },
        root: missingRoot
      }),
    /No canonical stable release tag is reachable/u
  );
  assert.equal(git(missingRoot, ["rev-parse", "HEAD"]), missingHead);
  assert.equal(git(missingRoot, ["status", "--porcelain"]), "");

  const malformedRoot = repository(context, {
    source: metadata,
    stable: metadata,
    stableTagAnnotated: true
  });
  const malformedHead = git(malformedRoot, ["rev-parse", "HEAD"]);
  assert.throws(
    () =>
      prepareDailyPreviewCommit({
        environment: {
          GITHUB_REF: "refs/heads/main",
          PREVIEW_DATE: "20260828",
          SOURCE_SHA: malformedHead
        },
        root: malformedRoot
      }),
    /must be one lightweight commit ref/u
  );
  assert.equal(git(malformedRoot, ["rev-parse", "HEAD"]), malformedHead);
  assert.equal(git(malformedRoot, ["status", "--porcelain"]), "");
});
