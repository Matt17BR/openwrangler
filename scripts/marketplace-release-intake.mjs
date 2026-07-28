import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseMetadata } from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const TAG_REF = /^refs\/tags\/(?<tag>v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAIN_REF = "refs/heads/main";
const CANONICAL_REPOSITORY = "https://github.com/Matt17BR/openwrangler.git";

function exactHead(root) {
  const value = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(value)) {
    throw new Error("The Azure Pipeline checkout did not resolve to one full Git commit.");
  }
  return value;
}

function resolveTagCommit(root, releaseTag) {
  const value = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `refs/tags/${releaseTag}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(value)) {
    throw new Error("The selected release tag did not resolve to one full Git commit.");
  }
  return value;
}

function packageJsonAtCommit(root, commit) {
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("Release package lookup requires one full Git commit.");
  }
  return execFileSync("git", ["cat-file", "blob", `${commit}:package.json`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
}

function currentMainCommit() {
  const output = execFileSync("git", ["ls-remote", "--refs", CANONICAL_REPOSITORY, MAIN_REF], {
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 30_000,
    windowsHide: true
  });
  const match = /^(?<commit>[0-9a-f]{40})\trefs\/heads\/main\n?$/u.exec(output);
  if (match?.groups?.commit === undefined) {
    throw new Error("Canonical GitHub main did not resolve to one unambiguous full commit.");
  }
  return match.groups.commit;
}

export function inspectMarketplaceReleaseIntake({
  buildReason,
  checkedOutCommit,
  currentMainCommit: resolvedMainCommit,
  existingReleaseTag,
  releasePackageJson,
  resolvedTagCommit,
  sourceBranch,
  sourceCommit
}) {
  const problems = [];
  const tagMatch = typeof sourceBranch === "string" ? TAG_REF.exec(sourceBranch) : null;
  const historical = existingReleaseTag !== "";
  const defaultManualRun = existingReleaseTag === "" && buildReason === "Manual" && sourceBranch === MAIN_REF;
  if (defaultManualRun) {
    if (
      typeof sourceCommit !== "string" ||
      !FULL_COMMIT.test(sourceCommit) ||
      typeof checkedOutCommit !== "string" ||
      checkedOutCommit !== sourceCommit
    ) {
      problems.push("The Azure Pipeline automation checkout must equal its exact event commit.");
    }
    return Object.freeze({
      eligible: false,
      prerelease: undefined,
      problems: Object.freeze(problems),
      promote: false,
      releaseCommit: undefined,
      releaseTag: undefined,
      version: undefined
    });
  }
  let releaseTag;
  if (historical) {
    if (
      typeof existingReleaseTag !== "string" ||
      !RELEASE_TAG.test(existingReleaseTag) ||
      buildReason !== "Manual" ||
      sourceBranch !== MAIN_REF ||
      resolvedMainCommit !== sourceCommit
    ) {
      problems.push(
        "An existing release may be promoted only by a manual run from protected main with one canonical numeric tag parameter."
      );
    } else {
      releaseTag = existingReleaseTag;
    }
  } else if (tagMatch === null) {
    problems.push("Automatic Marketplace promotion accepts only a canonical numeric Git tag ref.");
  } else {
    releaseTag = tagMatch.groups?.tag;
  }
  if (
    typeof sourceCommit !== "string" ||
    !FULL_COMMIT.test(sourceCommit) ||
    typeof checkedOutCommit !== "string" ||
    checkedOutCommit !== sourceCommit
  ) {
    problems.push("The Azure Pipeline automation checkout must equal its exact event commit.");
  }
  if (
    typeof resolvedTagCommit !== "string" ||
    !FULL_COMMIT.test(resolvedTagCommit) ||
    (!historical && resolvedTagCommit !== sourceCommit)
  ) {
    problems.push("The selected release tag must resolve to the exact automatic tag commit.");
  }
  let releaseManifest;
  try {
    releaseManifest = parseStrictJson(releasePackageJson, { maxBytes: 1024 * 1024 });
  } catch {
    problems.push("The selected release commit must contain one bounded strict package.json.");
  }
  if (
    typeof releaseManifest !== "object" ||
    releaseManifest === null ||
    Array.isArray(releaseManifest) ||
    releaseManifest.publisher !== "Matt17BR" ||
    releaseManifest.name !== "openwrangler"
  ) {
    problems.push("The selected release must describe Matt17BR.openwrangler.");
  }
  const metadata = inspectReleaseMetadata({ packageJson: releasePackageJson, releaseTag });
  problems.push(...metadata.problems);
  const eligible =
    problems.length === 0 &&
    typeof metadata.prerelease === "boolean" &&
    typeof metadata.version === "string" &&
    typeof resolvedTagCommit === "string";
  return Object.freeze({
    eligible,
    prerelease: metadata.prerelease,
    problems: Object.freeze(problems),
    promote: eligible,
    releaseCommit: resolvedTagCommit,
    releaseTag,
    version: metadata.version
  });
}

export function marketplaceReleaseIntakeOutput(result) {
  if (result.problems.length > 0) {
    throw new Error(`Marketplace release intake failed:\n- ${result.problems.join("\n- ")}`);
  }
  if (result.promote === false) {
    return Object.freeze([
      "##vso[task.setvariable variable=promote;isOutput=true]false",
      "No release tag was selected; the default manual main run completed without Marketplace promotion."
    ]);
  }
  if (
    !result.eligible ||
    result.promote !== true ||
    result.releaseTag === undefined ||
    result.releaseCommit === undefined
  ) {
    throw new Error("Marketplace release intake did not produce one promotable release.");
  }
  return Object.freeze([
    "##vso[task.setvariable variable=promote;isOutput=true]true",
    `##vso[task.setvariable variable=releaseTag;isOutput=true]${result.releaseTag}`,
    `##vso[task.setvariable variable=releaseCommit;isOutput=true]${result.releaseCommit}`,
    `##vso[task.setvariable variable=releasePrerelease;isOutput=true]${String(result.prerelease)}`,
    `Accepted ${result.prerelease ? "pre-release" : "stable"} Marketplace promotion ${result.releaseTag}.`
  ]);
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const existingReleaseTag = process.env.EXISTING_RELEASE_TAG ?? "";
  const tagMatch =
    typeof process.env.BUILD_SOURCEBRANCH === "string" ? TAG_REF.exec(process.env.BUILD_SOURCEBRANCH) : null;
  const releaseTag = existingReleaseTag === "" ? tagMatch?.groups?.tag : existingReleaseTag;
  const releaseCommit =
    typeof releaseTag === "string" && RELEASE_TAG.test(releaseTag) ? resolveTagCommit(root, releaseTag) : undefined;
  const result = inspectMarketplaceReleaseIntake({
    buildReason: process.env.BUILD_REASON,
    checkedOutCommit: exactHead(root),
    currentMainCommit: existingReleaseTag === "" ? undefined : currentMainCommit(),
    existingReleaseTag,
    releasePackageJson:
      releaseCommit === undefined
        ? readFileSync(resolve(root, "package.json"), "utf8")
        : packageJsonAtCommit(root, releaseCommit),
    resolvedTagCommit: releaseCommit,
    sourceBranch: process.env.BUILD_SOURCEBRANCH,
    sourceCommit: process.env.BUILD_SOURCEVERSION
  });
  for (const line of marketplaceReleaseIntakeOutput(result)) {
    console.log(line);
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
