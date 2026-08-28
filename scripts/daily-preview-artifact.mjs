import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dailyPreviewDateFromVersion, dailyPreviewVersionFromDate } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const VERSION_FILES = Object.freeze([
  ["packageJson", "package.json"],
  ["packageLock", "package-lock.json"],
  ["runtimeVersion", "python/openwrangler_runtime/version.py"]
]);
const VERSION_PATHS = VERSION_FILES.map(([, path]) => path).sort();

function git(root, args, environment = process.env) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true
  });
}

function repositoryRoot(root) {
  const requested = resolve(root);
  if (resolve(git(requested, ["rev-parse", "--show-toplevel"]).trim()) !== requested) {
    throw new Error("Daily preview preparation must run from the repository root.");
  }
  return requested;
}

function versionSources(root, commit) {
  return Object.fromEntries(
    VERSION_FILES.map(([key, path]) => [key, git(root, ["cat-file", "blob", `${commit}:${path}`])])
  );
}

function inspectVersionSources({ packageJson, packageLock, runtimeVersion }, label, requirePreview) {
  const manifest = parseStrictJson(packageJson, { maxBytes: 2 * 1024 * 1024 });
  const lock = parseStrictJson(packageLock, { maxBytes: 16 * 1024 * 1024 });
  const runtimeMatches = [...runtimeVersion.matchAll(/^__version__ = "([^"]+)"$/gmu)];
  const version = manifest?.version;
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.name !== "openwrangler" ||
    manifest.publisher !== "Matt17BR" ||
    typeof manifest.preview !== "boolean" ||
    (requirePreview && manifest.preview !== true) ||
    typeof version !== "string" ||
    runtimeMatches.length !== 1 ||
    runtimeMatches[0]?.[1] !== version ||
    lock === null ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    lock.name !== "openwrangler" ||
    lock.version !== version ||
    lock.lockfileVersion !== 3 ||
    lock.packages?.[""]?.name !== "openwrangler" ||
    lock.packages[""].version !== version
  ) {
    throw new Error(`${label} extension, lockfile, and runtime versions must match.`);
  }
  return { lock, manifest, version };
}

function renderVersionSources(sources, date) {
  const version = dailyPreviewVersionFromDate(date);
  if (version === undefined) throw new Error("A daily preview requires one valid UTC date in YYYYMMDD form.");
  const source = inspectVersionSources(sources, "Source", false);
  if (source.version === version) throw new Error("A daily preview must not reuse the protected-main version.");
  return {
    packageJson: `${JSON.stringify({ ...source.manifest, preview: true, version }, null, 2)}\n`,
    packageLock: `${JSON.stringify(
      {
        ...source.lock,
        version,
        packages: { ...source.lock.packages, "": { ...source.lock.packages[""], version } }
      },
      null,
      2
    )}\n`,
    runtimeVersion: sources.runtimeVersion.replace(/^__version__ = "[^"]+"$/mu, `__version__ = "${version}"`),
    version
  };
}

export function dailyPreviewIdentity(environment = process.env) {
  const version = dailyPreviewVersionFromDate(environment.PREVIEW_DATE);
  if (environment.GITHUB_REF !== "refs/heads/main") throw new Error("A daily preview must come from refs/heads/main.");
  if (!FULL_SHA.test(environment.SOURCE_SHA ?? "")) throw new Error("SOURCE_SHA must be one lowercase commit SHA.");
  if (version === undefined) throw new Error("PREVIEW_DATE must be one valid UTC date in YYYYMMDD form.");
  return { date: environment.PREVIEW_DATE, releaseTag: `v${version}`, sourceSha: environment.SOURCE_SHA, version };
}

export function dailyPreviewReleaseNotes({ sourceSha, version }) {
  const date = dailyPreviewDateFromVersion(version);
  if (!FULL_SHA.test(sourceSha ?? "") || date === undefined) {
    throw new Error("Daily preview release notes require one source commit and dated preview version.");
  }
  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  return [
    `# Open Wrangler ${version}`,
    "",
    `This daily preview packages protected \`main\` commit \`${sourceSha}\` from ${isoDate}.`,
    "Its exact VSIX passed the short installed smoke in stable VS Code before publication.",
    ""
  ].join("\n");
}

export function inspectDailyPreviewSourceCommit({ commit, expectedParent, releaseTag, root }) {
  const sourceRoot = repositoryRoot(root);
  if (!FULL_SHA.test(commit ?? "") || (expectedParent !== undefined && !FULL_SHA.test(expectedParent))) {
    throw new Error("Daily preview source inspection requires full lowercase commit IDs.");
  }
  const history = git(sourceRoot, ["rev-list", "--parents", "-n", "1", commit]).trim().split(" ");
  const parentCommit = history[1];
  if (history.length !== 2 || history[0] !== commit || !FULL_SHA.test(parentCommit ?? "")) {
    throw new Error("A daily preview source must be one direct single-parent commit.");
  }
  if (expectedParent !== undefined && parentCommit !== expectedParent) {
    throw new Error("The daily preview source parent does not match protected main.");
  }
  const current = versionSources(sourceRoot, commit);
  const parsed = inspectVersionSources(current, "Daily preview", true);
  const date = dailyPreviewDateFromVersion(parsed.version);
  if (date === undefined || releaseTag !== `v${parsed.version}`) {
    throw new Error("The daily preview version and release tag must match one UTC date.");
  }
  const changed = git(sourceRoot, ["diff", "--name-only", "--no-renames", "-z", parentCommit, commit, "--"]);
  const changedPaths = changed === "" ? [] : changed.slice(0, -1).split("\0").sort();
  if (!changed.endsWith("\0") || JSON.stringify(changedPaths) !== JSON.stringify(VERSION_PATHS)) {
    throw new Error("The daily preview commit may change only its three version files.");
  }
  const expected = renderVersionSources(versionSources(sourceRoot, parentCommit), date);
  if (VERSION_FILES.some(([key]) => current[key] !== expected[key])) {
    throw new Error("The daily preview version files differ from their protected-main source.");
  }
  return { commit, parentCommit, previewDate: date, releaseTag, version: parsed.version };
}

export function prepareDailyPreviewCommit({ environment = process.env, root }) {
  const sourceRoot = repositoryRoot(root);
  const identity = dailyPreviewIdentity(environment);
  if (git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== identity.sourceSha) {
    throw new Error("Daily preview preparation must start at SOURCE_SHA.");
  }
  if (git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") {
    throw new Error("Daily preview preparation requires one clean source checkout.");
  }
  const rendered = renderVersionSources(versionSources(sourceRoot, identity.sourceSha), identity.date);
  for (const [key, path] of VERSION_FILES) writeFileSync(resolve(sourceRoot, path), rendered[key]);
  git(sourceRoot, ["add", "--", ...VERSION_PATHS]);
  const commitDate = `${identity.date.slice(0, 4)}-${identity.date.slice(4, 6)}-${identity.date.slice(6, 8)}T00:00:00Z`;
  git(
    sourceRoot,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "--no-gpg-sign",
      "-m",
      `Prepare daily preview ${identity.version}`
    ],
    {
      ...process.env,
      GIT_AUTHOR_DATE: commitDate,
      GIT_AUTHOR_EMAIL: "actions@users.noreply.github.com",
      GIT_AUTHOR_NAME: "Open Wrangler Automation",
      GIT_COMMITTER_DATE: commitDate,
      GIT_COMMITTER_EMAIL: "actions@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Open Wrangler Automation"
    }
  );
  const generatedSha = git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  if (environment.EXPECTED_GENERATED_SHA !== undefined && generatedSha !== environment.EXPECTED_GENERATED_SHA) {
    throw new Error("The reconstructed daily preview commit differs from the qualified source commit.");
  }
  inspectDailyPreviewSourceCommit({
    commit: generatedSha,
    expectedParent: identity.sourceSha,
    releaseTag: identity.releaseTag,
    root: sourceRoot
  });
  return { ...identity, generatedSha };
}

function main(environment) {
  if (process.argv.length !== 3 || process.argv[2] !== "prepare") {
    throw new Error("Usage: node scripts/daily-preview-artifact.mjs prepare");
  }
  const result = prepareDailyPreviewCommit({ environment, root: resolve(import.meta.dirname, "..") });
  if (!environment.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    environment.GITHUB_OUTPUT,
    `preview_date=${result.date}\nrelease_tag=${result.releaseTag}\ngenerated_sha=${result.generatedSha}\n`
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Daily preview preparation failed."}\n`);
    process.exitCode = 1;
  }
}
