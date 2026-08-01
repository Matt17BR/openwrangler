import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  inspectReleaseMetadata,
  MAIN_RELEASE_BRANCH,
  NUMERIC_RELEASE_VERSION,
  releaseSourcePolicyForVersion,
  V1_MAINTENANCE_BRANCH
} from "./release-metadata.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const TAG_REF = /^refs\/tags\/(?<tag>v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const MAIN_REF = `refs/heads/${MAIN_RELEASE_BRANCH}`;
const V1_MAINTENANCE_REF = `refs/heads/${V1_MAINTENANCE_BRANCH}`;
const PROTECTED_RELEASE_REFS = new Set([MAIN_REF, V1_MAINTENANCE_REF]);
const CANONICAL_REPOSITORY = "https://github.com/Matt17BR/openwrangler.git";
const AUTOMATIC_BRANCH_REASONS = new Set(["BatchedCI", "IndividualCI"]);
const MAX_RECOVERY_CHANGED_PATHS = 4096;
const MAX_RECOVERY_CHANGED_PATH_BYTES = 2 * 1024 * 1024;
export const MARKETPLACE_RECOVERY_PATHS = Object.freeze([
  "azure-pipelines-marketplace.yml",
  "package-lock.json",
  "package.json",
  "scripts/bounded-file-read.mjs",
  "scripts/copy-extension-test-runtime-assets.mjs",
  "scripts/cursor-acquisition.mjs",
  "scripts/download-canonical-github-release.mjs",
  "scripts/editor-acceptance-evidence.mjs",
  "scripts/editor-acceptance.mjs",
  "scripts/installed-performance-report.mjs",
  "scripts/installed-performance-system.mjs",
  "scripts/marketplace-identity-profile.mjs",
  "scripts/marketplace-release-intake.mjs",
  "scripts/packaged-editor-orchestration.mjs",
  "scripts/prepare-xvfb.mjs",
  "scripts/release-metadata.mjs",
  "scripts/remote-workspace-acquisition.mjs",
  "scripts/remote-workspace-contract.mjs",
  "scripts/run-installed-performance.mjs",
  "scripts/strict-json.mjs",
  "scripts/verify-canonical-release-artifact.mjs",
  "scripts/verify-marketplace-publication.mjs",
  "scripts/verify-registry-release-artifact.mjs",
  "scripts/vsix-archive.mjs",
  "scripts/vsix-contents.mjs",
  "src/shared/installedPerformanceFixtureManifest.cjs",
  "src/shared/strictJson.cjs"
]);
const RECOVERY_PATHS = new Set(MARKETPLACE_RECOVERY_PATHS);

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

function resolveTagCommit(root, releaseTag, { optional = false } = {}) {
  let value;
  try {
    value = execFileSync(
      "git",
      [
        "rev-parse",
        "--verify",
        ...(optional ? ["--quiet"] : []),
        "--end-of-options",
        `refs/tags/${releaseTag}^{commit}`
      ],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 4096,
        timeout: 10_000,
        windowsHide: true
      }
    ).trim();
  } catch (error) {
    if (optional && typeof error === "object" && error !== null && error.status === 1) {
      return undefined;
    }
    throw error;
  }
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

function currentProtectedBranchCommit(sourceRef) {
  if (!PROTECTED_RELEASE_REFS.has(sourceRef)) {
    throw new Error("Marketplace recovery requires one recognized protected release branch.");
  }
  const output = execFileSync("git", ["ls-remote", "--refs", CANONICAL_REPOSITORY, sourceRef], {
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 30_000,
    windowsHide: true
  });
  const match = /^(?<commit>[0-9a-f]{40})\t(?<ref>[^\t\r\n]+)\n?$/u.exec(output);
  if (match?.groups?.commit === undefined || match.groups.ref !== sourceRef) {
    throw new Error("The canonical protected release branch did not resolve to one unambiguous full commit.");
  }
  return match.groups.commit;
}

function releaseBranchEvidence(root, sourceRef, releaseCommit) {
  if (!PROTECTED_RELEASE_REFS.has(sourceRef) || !FULL_COMMIT.test(releaseCommit)) {
    throw new Error("Marketplace release containment requires one recognized branch and full release commit.");
  }
  execFileSync(
    "git",
    [
      "fetch",
      "--no-tags",
      "--quiet",
      "--force",
      "--filter=blob:none",
      "--no-recurse-submodules",
      CANONICAL_REPOSITORY,
      sourceRef
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true
    }
  );
  const branchCommit = execFileSync("git", ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  if (!FULL_COMMIT.test(branchCommit)) {
    throw new Error("The fetched protected release branch did not resolve to one full commit.");
  }
  let contained;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", releaseCommit, branchCommit], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4096,
      timeout: 30_000,
      windowsHide: true
    });
    contained = true;
  } catch (error) {
    if (typeof error === "object" && error !== null && error.status === 1) {
      contained = false;
    } else {
      throw error;
    }
  }
  if (currentProtectedBranchCommit(sourceRef) !== branchCommit) {
    throw new Error("The fetched protected release branch changed before containment could be accepted.");
  }
  return Object.freeze({ branchCommit, contained, sourceRef });
}

function currentTagCommit(releaseTag) {
  const ref = `refs/tags/${releaseTag}`;
  const output = execFileSync("git", ["ls-remote", "--refs", CANONICAL_REPOSITORY, ref], {
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 30_000,
    windowsHide: true
  });
  if (output === "") {
    return undefined;
  }
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 1) {
    throw new Error("Canonical GitHub release tag lookup returned an ambiguous result.");
  }
  const [commit, resolvedRef, ...extra] = lines[0].split("\t");
  if (!FULL_COMMIT.test(commit ?? "") || resolvedRef !== ref || extra.length !== 0) {
    throw new Error("Canonical GitHub release tag did not resolve to one exact lightweight tag commit.");
  }
  return commit;
}

export function inspectMarketplaceRecoveryChange({ changedPaths, parentCommits }) {
  const problems = [];
  if (
    !Array.isArray(parentCommits) ||
    parentCommits.length > 64 ||
    parentCommits.some((commit) => typeof commit !== "string" || !FULL_COMMIT.test(commit)) ||
    new Set(parentCommits).size !== parentCommits.length
  ) {
    problems.push("Protected release-branch recovery requires an unambiguous bounded parent-commit list.");
  }
  const boundedPathList = Array.isArray(changedPaths) && changedPaths.length <= MAX_RECOVERY_CHANGED_PATHS;
  let changedPathBytes = 0;
  if (boundedPathList) {
    for (const path of changedPaths) {
      if (typeof path === "string") {
        changedPathBytes += Buffer.byteLength(path, "utf8") + 1;
      }
    }
  }
  if (
    !boundedPathList ||
    changedPathBytes > MAX_RECOVERY_CHANGED_PATH_BYTES ||
    changedPaths.some(
      (path) =>
        typeof path !== "string" ||
        path.length === 0 ||
        Buffer.byteLength(path, "utf8") > 4096 ||
        path.includes("\0") ||
        path.startsWith("/") ||
        path.includes("\\")
    ) ||
    new Set(changedPaths).size !== changedPaths.length
  ) {
    problems.push("Protected release-branch recovery requires one unambiguous bounded changed-path list.");
  }
  if (problems.length > 0) {
    return Object.freeze({
      problems: Object.freeze(problems),
      reason: undefined,
      relevant: false
    });
  }
  if (parentCommits.length !== 1) {
    return Object.freeze({
      problems: Object.freeze([]),
      reason: "ambiguous-history",
      relevant: false
    });
  }
  const relevant = changedPaths.some((path) => RECOVERY_PATHS.has(path));
  return Object.freeze({
    problems: Object.freeze([]),
    reason: relevant ? undefined : "irrelevant-paths",
    relevant
  });
}

function recoveryChangeAtCommit(root, commit) {
  if (!FULL_COMMIT.test(commit)) {
    throw new Error("Protected release-branch recovery change detection requires one full Git commit.");
  }
  const history = execFileSync("git", ["rev-list", "--parents", "-n", "1", commit], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4096,
    timeout: 10_000,
    windowsHide: true
  }).trim();
  const [resolvedCommit, ...parentCommits] = history.split(" ");
  if (
    resolvedCommit !== commit ||
    parentCommits.some((parent) => !FULL_COMMIT.test(parent)) ||
    new Set(parentCommits).size !== parentCommits.length
  ) {
    throw new Error("Protected release-branch recovery could not bind one exact commit ancestry.");
  }
  if (parentCommits.length !== 1) {
    return Object.freeze({ changedPaths: Object.freeze([]), parentCommits: Object.freeze(parentCommits) });
  }
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", parentCommits[0], commit, "--"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
    windowsHide: true
  });
  if (output.length > 0 && output.at(-1) !== 0) {
    throw new Error("Protected release-branch recovery received an unterminated Git path list.");
  }
  const encodedPaths = output.length === 0 ? [] : output.subarray(0, -1).toString("binary").split("\0");
  const changedPaths = encodedPaths.map((encoded) => {
    const bytes = Buffer.from(encoded, "binary");
    const path = bytes.toString("utf8");
    if (path.length === 0 || !Buffer.from(path, "utf8").equals(bytes)) {
      throw new Error("Protected release-branch recovery received a non-canonical Git path.");
    }
    return path;
  });
  return Object.freeze({
    changedPaths: Object.freeze(changedPaths),
    parentCommits: Object.freeze(parentCommits)
  });
}

export function inspectMarketplaceRecoverySource(packageJson) {
  const problems = [];
  let manifest;
  try {
    manifest = parseStrictJson(packageJson, { maxBytes: 1024 * 1024 });
  } catch {
    problems.push("Protected release-branch recovery requires one bounded strict package.json.");
  }
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest) ||
    manifest.publisher !== "Matt17BR" ||
    manifest.name !== "openwrangler"
  ) {
    problems.push("Protected release-branch recovery must describe Matt17BR.openwrangler.");
  }
  const version =
    typeof manifest === "object" &&
    manifest !== null &&
    !Array.isArray(manifest) &&
    typeof manifest.version === "string" &&
    NUMERIC_RELEASE_VERSION.test(manifest.version)
      ? manifest.version
      : undefined;
  if (version === undefined) {
    problems.push("Protected release-branch recovery requires one canonical numeric package version.");
  }
  const releaseTag = version === undefined ? undefined : `v${version}`;
  if (releaseTag !== undefined) {
    const metadata = inspectReleaseMetadata({ packageJson, releaseTag });
    problems.push(...metadata.problems);
  }
  return Object.freeze({
    problems: Object.freeze(problems),
    releaseTag,
    version
  });
}

export function inspectMarketplaceReleaseIntake({
  buildReason,
  checkedOutCommit,
  currentProtectedBranchCommit: resolvedProtectedBranchCommit,
  currentPackageJson,
  existingReleaseTag,
  recoveryChange,
  releasePackageJson,
  releaseContainedInProtectedBranch,
  releaseProtectedBranchRef,
  remoteTagCommit,
  resolvedTagCommit,
  sourceBranch,
  sourceCommit
}) {
  const problems = [];
  const tagMatch = typeof sourceBranch === "string" ? TAG_REF.exec(sourceBranch) : null;
  const historical = existingReleaseTag !== "";
  const protectedReleaseBranch = PROTECTED_RELEASE_REFS.has(sourceBranch);
  const automaticProtectedBranch =
    existingReleaseTag === "" && protectedReleaseBranch && AUTOMATIC_BRANCH_REASONS.has(buildReason);
  const defaultManualRun = existingReleaseTag === "" && buildReason === "Manual" && protectedReleaseBranch;
  if (
    typeof sourceCommit !== "string" ||
    !FULL_COMMIT.test(sourceCommit) ||
    typeof checkedOutCommit !== "string" ||
    checkedOutCommit !== sourceCommit
  ) {
    problems.push("The Azure Pipeline automation checkout must equal its exact event commit.");
  }
  if (defaultManualRun) {
    return Object.freeze({
      eligible: false,
      noOpReason: "manual-empty",
      prerelease: undefined,
      problems: Object.freeze(problems),
      promote: false,
      releaseCommit: undefined,
      releaseTag: undefined,
      version: undefined
    });
  }
  let releaseTag;
  let releaseMayPrecedeAutomation = false;
  if (historical) {
    if (
      typeof existingReleaseTag !== "string" ||
      !RELEASE_TAG.test(existingReleaseTag) ||
      buildReason !== "Manual" ||
      !protectedReleaseBranch ||
      resolvedProtectedBranchCommit !== sourceCommit
    ) {
      problems.push(
        "An existing release may be promoted only by a manual run from its protected release branch with one canonical numeric tag parameter."
      );
    } else {
      releaseTag = existingReleaseTag;
      releaseMayPrecedeAutomation = true;
    }
  } else if (automaticProtectedBranch) {
    const change = inspectMarketplaceRecoveryChange(
      recoveryChange ?? { changedPaths: undefined, parentCommits: undefined }
    );
    problems.push(...change.problems);
    if (!change.relevant && problems.length === 0) {
      return Object.freeze({
        eligible: false,
        noOpReason: change.reason,
        prerelease: undefined,
        problems: Object.freeze([]),
        promote: false,
        releaseCommit: undefined,
        releaseTag: undefined,
        version: undefined
      });
    }
    const recovery = inspectMarketplaceRecoverySource(currentPackageJson);
    problems.push(...recovery.problems);
    releaseTag = recovery.releaseTag;
    const recoveryPolicy = releaseSourcePolicyForVersion(recovery.version);
    if (problems.length === 0 && recoveryPolicy?.ref !== sourceBranch) {
      return Object.freeze({
        eligible: false,
        noOpReason: "inactive-branch",
        prerelease: undefined,
        problems: Object.freeze([]),
        promote: false,
        releaseCommit: undefined,
        releaseTag,
        version: recovery.version
      });
    }
    releaseMayPrecedeAutomation = true;
    if (resolvedProtectedBranchCommit !== sourceCommit) {
      problems.push("Automatic Marketplace recovery must run from the current public protected release-branch commit.");
    }
    if (resolvedTagCommit === undefined && remoteTagCommit === undefined && problems.length === 0) {
      return Object.freeze({
        eligible: false,
        noOpReason: "missing-tag",
        prerelease: undefined,
        problems: Object.freeze([]),
        promote: false,
        releaseCommit: undefined,
        releaseTag,
        version: recovery.version
      });
    }
  } else if (tagMatch === null) {
    problems.push(
      "Automatic Marketplace promotion accepts only a canonical numeric Git tag ref or reviewed protected release-branch recovery."
    );
  } else {
    releaseTag = tagMatch.groups?.tag;
  }
  if (
    typeof resolvedTagCommit !== "string" ||
    !FULL_COMMIT.test(resolvedTagCommit) ||
    (!releaseMayPrecedeAutomation && resolvedTagCommit !== sourceCommit)
  ) {
    problems.push("The selected release tag must resolve to the exact automatic tag commit.");
  }
  if (
    typeof resolvedTagCommit === "string" &&
    (typeof remoteTagCommit !== "string" || !FULL_COMMIT.test(remoteTagCommit) || remoteTagCommit !== resolvedTagCommit)
  ) {
    problems.push("The selected release must remain one exact public lightweight tag commit.");
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
  const sourcePolicy = releaseSourcePolicyForVersion(metadata.version);
  if (historical && sourcePolicy?.ref !== sourceBranch) {
    problems.push("Manual Marketplace recovery must run from the protected branch that owns the selected version.");
  }
  if (
    typeof resolvedTagCommit === "string" &&
    (releaseContainedInProtectedBranch !== true ||
      releaseProtectedBranchRef !== sourcePolicy?.ref ||
      typeof resolvedProtectedBranchCommit !== "string" ||
      !FULL_COMMIT.test(resolvedProtectedBranchCommit))
  ) {
    problems.push("The selected release commit must be contained in its current version-owned protected branch.");
  }
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
    if (result.noOpReason === "missing-tag" && result.releaseTag !== undefined) {
      return Object.freeze([
        "##vso[task.setvariable variable=promote;isOutput=true]false",
        `No immutable release tag ${result.releaseTag} exists for the current package version; protected release-branch recovery completed without Marketplace promotion.`
      ]);
    }
    if (result.noOpReason === "irrelevant-paths") {
      return Object.freeze([
        "##vso[task.setvariable variable=promote;isOutput=true]false",
        "The protected release-branch commit changed no reviewed Marketplace recovery path; promotion was not queued."
      ]);
    }
    if (result.noOpReason === "ambiguous-history") {
      return Object.freeze([
        "##vso[task.setvariable variable=promote;isOutput=true]false",
        "The protected release-branch commit was not a single-parent change; automatic recovery safely completed without promotion."
      ]);
    }
    if (result.noOpReason === "inactive-branch") {
      return Object.freeze([
        "##vso[task.setvariable variable=promote;isOutput=true]false",
        "This protected branch does not own the current package version; Marketplace recovery was not queued."
      ]);
    }
    return Object.freeze([
      "##vso[task.setvariable variable=promote;isOutput=true]false",
      "No release tag was selected; the default manual protected-branch run completed without Marketplace promotion."
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
  const sourceBranch = process.env.BUILD_SOURCEBRANCH;
  const buildReason = process.env.BUILD_REASON;
  const tagMatch = typeof sourceBranch === "string" ? TAG_REF.exec(sourceBranch) : null;
  const currentPackageJson = readFileSync(resolve(root, "package.json"), "utf8");
  const checkedOutCommit = exactHead(root);
  const automaticProtectedBranch =
    existingReleaseTag === "" && PROTECTED_RELEASE_REFS.has(sourceBranch) && AUTOMATIC_BRANCH_REASONS.has(buildReason);
  const recoveryChange = automaticProtectedBranch
    ? recoveryChangeAtCommit(root, checkedOutCommit)
    : { changedPaths: undefined, parentCommits: undefined };
  const inspectedRecoveryChange = automaticProtectedBranch
    ? inspectMarketplaceRecoveryChange(recoveryChange)
    : { problems: [], relevant: false };
  const relevantAutomaticProtectedBranch =
    automaticProtectedBranch && inspectedRecoveryChange.problems.length === 0 && inspectedRecoveryChange.relevant;
  const recovery = relevantAutomaticProtectedBranch
    ? inspectMarketplaceRecoverySource(currentPackageJson)
    : { releaseTag: undefined };
  const activeAutomaticProtectedBranch =
    relevantAutomaticProtectedBranch && releaseSourcePolicyForVersion(recovery.version)?.ref === sourceBranch;
  const inactiveAutomaticProtectedBranch = relevantAutomaticProtectedBranch && !activeAutomaticProtectedBranch;
  const releaseTag = existingReleaseTag !== "" ? existingReleaseTag : (tagMatch?.groups?.tag ?? recovery.releaseTag);
  const releaseCommit =
    !inactiveAutomaticProtectedBranch && typeof releaseTag === "string" && RELEASE_TAG.test(releaseTag)
      ? resolveTagCommit(root, releaseTag, { optional: activeAutomaticProtectedBranch })
      : undefined;
  const releasePackageJson =
    releaseCommit === undefined ? currentPackageJson : packageJsonAtCommit(root, releaseCommit);
  const selectedMetadata =
    releaseCommit !== undefined && releaseTag !== undefined
      ? inspectReleaseMetadata({ packageJson: releasePackageJson, releaseTag })
      : undefined;
  const selectedPolicy =
    selectedMetadata?.problems.length === 0 ? releaseSourcePolicyForVersion(selectedMetadata.version) : undefined;
  const branchEvidence =
    releaseCommit !== undefined && selectedPolicy !== undefined
      ? releaseBranchEvidence(root, selectedPolicy.ref, releaseCommit)
      : undefined;
  const result = inspectMarketplaceReleaseIntake({
    buildReason,
    checkedOutCommit,
    currentProtectedBranchCommit:
      branchEvidence?.branchCommit ??
      (activeAutomaticProtectedBranch ? currentProtectedBranchCommit(sourceBranch) : undefined),
    currentPackageJson,
    existingReleaseTag,
    recoveryChange,
    releaseContainedInProtectedBranch: branchEvidence?.contained,
    releasePackageJson,
    releaseProtectedBranchRef: branchEvidence?.sourceRef,
    remoteTagCommit:
      (releaseCommit !== undefined || existingReleaseTag !== "" || activeAutomaticProtectedBranch) &&
      releaseTag !== undefined
        ? currentTagCommit(releaseTag)
        : undefined,
    resolvedTagCommit: releaseCommit,
    sourceBranch,
    sourceCommit: process.env.BUILD_SOURCEVERSION
  });
  for (const line of marketplaceReleaseIntakeOutput(result)) {
    console.log(line);
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
