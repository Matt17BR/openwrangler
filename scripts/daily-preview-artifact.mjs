import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  classifyNumericReleaseVersion,
  dailyPreviewDateFromVersion,
  dailyPreviewVersionFromDate,
  isDailyPreviewVersion
} from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_SHA = /^[0-9a-f]{40}$/u;
const CANONICAL_NUMERIC_RELEASE_TAG = /^v(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
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
  const classification = classifyNumericReleaseVersion(version);
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
  if (classification === undefined || manifest.preview !== (classification.channel === "preview")) {
    throw new Error(`${label} version and preview flag must describe a permitted release channel.`);
  }
  return { lock, manifest, version };
}

function compareReleaseVersions(left, right) {
  const leftParts = left.split(".").map(BigInt);
  const rightParts = right.split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function requireFullTagCheckout(root) {
  if (git(root, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new Error("Stable release tag authority requires one full source checkout with tags.");
  }
}

function inspectStableTagAuthority(root, sourceCommit, tag, expectedCommit) {
  requireFullTagCheckout(root);
  const tagMatch = CANONICAL_NUMERIC_RELEASE_TAG.exec(tag);
  const version = tagMatch?.groups?.version;
  if (version === undefined || classifyNumericReleaseVersion(version)?.channel !== "stable") {
    throw new Error(`Stable release tag authority requires one canonical stable tag; received ${String(tag)}.`);
  }
  let commit;
  let type;
  try {
    commit = git(root, ["rev-parse", "--verify", "--end-of-options", `refs/tags/${tag}`]).trim();
    type = git(root, ["cat-file", "-t", `refs/tags/${tag}`]).trim();
  } catch {
    throw new Error(`Stable release tag ${tag} is missing from the full source checkout.`);
  }
  if (type !== "commit" || !FULL_SHA.test(commit)) {
    throw new Error(`Stable release tag ${tag} must be one lightweight commit ref.`);
  }
  if (expectedCommit !== undefined && commit !== expectedCommit) {
    throw new Error(`Stable release tag ${tag} moved from its bound commit.`);
  }
  try {
    git(root, ["merge-base", "--is-ancestor", commit, sourceCommit]);
  } catch {
    throw new Error(`Stable release tag ${tag} is not reachable from the protected-main source commit.`);
  }
  let tagged;
  try {
    tagged = inspectVersionSources(versionSources(root, commit), `Stable release tag ${tag}`, false);
  } catch {
    throw new Error(`Stable release tag ${tag} does not contain coherent stable version metadata.`);
  }
  if (tagged.version !== version || tagged.manifest.preview !== false) {
    throw new Error(`Stable release tag ${tag} does not match its coherent stable version metadata.`);
  }
  return Object.freeze({ commit, tag, version });
}

function latestStableTagAuthority(root, sourceCommit) {
  if (!FULL_SHA.test(sourceCommit ?? "")) {
    throw new Error("Stable release tag authority requires one full protected-main source commit.");
  }
  requireFullTagCheckout(root);
  const tags = git(root, ["tag", "--no-column", "--merged", sourceCommit, "--list", "--format=%(refname:strip=2)"])
    .split("\n")
    .filter((tag) => tag.length > 0);
  const stable = [];
  for (const tag of tags) {
    const match = CANONICAL_NUMERIC_RELEASE_TAG.exec(tag);
    if (match === null) continue;
    const classification = classifyNumericReleaseVersion(match.groups?.version);
    if (classification === undefined) {
      throw new Error(`Reachable numeric release tag ${tag} does not describe a permitted release channel.`);
    }
    if (classification.channel === "stable") {
      stable.push({ tag, version: classification.version });
    }
  }
  if (stable.length === 0) {
    throw new Error("No canonical stable release tag is reachable from the protected-main source commit.");
  }
  let latest = stable[0];
  for (const candidate of stable.slice(1)) {
    if (compareReleaseVersions(candidate.version, latest.version) > 0) latest = candidate;
  }
  const matches = stable.filter((candidate) => compareReleaseVersions(candidate.version, latest.version) === 0);
  if (matches.length !== 1) {
    throw new Error("The latest reachable stable release tag authority is ambiguous.");
  }
  return inspectStableTagAuthority(root, sourceCommit, latest.tag);
}

function stableAuthorityFromCommitMessage(root, commit, parentCommit, previewVersion) {
  const object = git(root, ["cat-file", "commit", commit]);
  const messageStart = object.indexOf("\n\n");
  if (messageStart === -1) {
    throw new Error("The daily preview commit does not contain one canonical commit message.");
  }
  const message = object.slice(messageStart + 2);
  if (message === `Prepare daily preview ${previewVersion}\n`) {
    return Object.freeze({ legacySourceSeries: true });
  }
  const match = new RegExp(
    `^Prepare daily preview ${previewVersion.replaceAll(".", "\\.")}\\n\\n` +
      "Stable-Release-Tag: (?<tag>v(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))\\n" +
      "Stable-Release-Commit: (?<commit>[0-9a-f]{40})\\n$",
    "u"
  ).exec(message);
  if (match?.groups?.tag === undefined || match.groups.commit === undefined) {
    throw new Error("The daily preview commit does not bind one stable release tag authority.");
  }
  return Object.freeze({
    legacySourceSeries: false,
    stable: inspectStableTagAuthority(root, parentCommit, match.groups.tag, match.groups.commit)
  });
}

function renderVersionSourcesAtVersion(sources, source, version) {
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

function renderVersionSources(sources, date, stableVersion) {
  const source = inspectVersionSources(sources, "Source", false);
  if (isDailyPreviewVersion(source.version)) {
    throw new Error("Protected-main source metadata must not already be a daily preview.");
  }
  const version = dailyPreviewVersionFromDate(date, stableVersion);
  if (version === undefined) {
    throw new Error("A daily preview requires one valid UTC date after its bound stable release version.");
  }
  return renderVersionSourcesAtVersion(sources, source, version);
}

function renderLegacySourceSeriesVersionSources(sources, date) {
  const source = inspectVersionSources(sources, "Legacy daily preview source", false);
  const [sourceMajor, sourceMinor] = source.version.split(".").map(BigInt);
  const series = sourceMajor < 2n ? "1.99" : `${sourceMajor}.${sourceMinor}`;
  const version = `${series}.${date}`;
  if (
    isDailyPreviewVersion(source.version) ||
    dailyPreviewDateFromVersion(version) !== date ||
    compareReleaseVersions(version, source.version) <= 0
  ) {
    throw new Error("A trailerless daily preview must match the exact previous source-series generator.");
  }
  return renderVersionSourcesAtVersion(sources, source, version);
}

export function dailyPreviewIdentity(environment = process.env, stableAuthority) {
  const version = dailyPreviewVersionFromDate(environment.PREVIEW_DATE, stableAuthority?.version);
  if (environment.GITHUB_REF !== "refs/heads/main") throw new Error("A daily preview must come from refs/heads/main.");
  if (!FULL_SHA.test(environment.SOURCE_SHA ?? "")) throw new Error("SOURCE_SHA must be one lowercase commit SHA.");
  if (!FULL_SHA.test(stableAuthority?.commit ?? "") || stableAuthority?.tag !== `v${stableAuthority?.version}`) {
    throw new Error("A daily preview requires one bound stable release tag authority.");
  }
  if (version === undefined) throw new Error("PREVIEW_DATE must be one valid UTC date in YYYYMMDD form.");
  return {
    date: environment.PREVIEW_DATE,
    releaseTag: `v${version}`,
    sourceSha: environment.SOURCE_SHA,
    stableCommit: stableAuthority.commit,
    stableTag: stableAuthority.tag,
    stableVersion: stableAuthority.version,
    version
  };
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
    `The ${isoDate} daily preview packages protected \`main\` commit \`${sourceSha}\`.`,
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
  const binding = stableAuthorityFromCommitMessage(sourceRoot, commit, parentCommit, parsed.version);
  const stable = binding.legacySourceSeries ? latestStableTagAuthority(sourceRoot, parentCommit) : binding.stable;
  const parentSources = versionSources(sourceRoot, parentCommit);
  const expected = renderVersionSources(parentSources, date, stable.version);
  if (binding.legacySourceSeries) {
    const legacyExpected = renderLegacySourceSeriesVersionSources(parentSources, date);
    if (
      legacyExpected.version !== expected.version ||
      VERSION_FILES.some(([key]) => current[key] !== legacyExpected[key])
    ) {
      throw new Error("The trailerless daily preview series does not match the latest stable release tag.");
    }
  }
  if (parsed.version !== expected.version) {
    throw new Error("The daily preview series does not match its bound stable release tag.");
  }
  if (VERSION_FILES.some(([key]) => current[key] !== expected[key])) {
    throw new Error("The daily preview version files differ from their protected-main source.");
  }
  return {
    commit,
    parentCommit,
    previewDate: date,
    releaseTag,
    stableCommit: stable.commit,
    stableTag: stable.tag,
    stableVersion: stable.version,
    version: parsed.version
  };
}

export function prepareDailyPreviewCommit({ environment = process.env, root }) {
  const sourceRoot = repositoryRoot(root);
  const sourceSha = git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const sourceFiles = versionSources(sourceRoot, sourceSha);
  inspectVersionSources(sourceFiles, "Source", false);
  const stable = latestStableTagAuthority(sourceRoot, sourceSha);
  const identity = dailyPreviewIdentity(environment, stable);
  if (sourceSha !== identity.sourceSha) {
    throw new Error("Daily preview preparation must start at SOURCE_SHA.");
  }
  if (git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim() !== "") {
    throw new Error("Daily preview preparation requires one clean source checkout.");
  }
  const rendered = renderVersionSources(sourceFiles, identity.date, identity.stableVersion);
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
      `Prepare daily preview ${identity.version}`,
      "-m",
      `Stable-Release-Tag: ${identity.stableTag}\nStable-Release-Commit: ${identity.stableCommit}`
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
