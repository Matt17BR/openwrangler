import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const ROOT_NON_PACKAGED_DOCUMENTATION = new Set(["AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]);
const PACKAGED_DOCUMENT_PATHS = new Set(["README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
export const BENCHMARK_HARNESS_PATHS = Object.freeze([
  "docs/performance-comparison.md",
  "docs/testing.md",
  "python/benchmarks/local_mixed_parquet.py",
  "python/tests/test_installed_editor_fixtures.py",
  "scripts/data-wrangler-comparison-neutral-driver.mjs",
  "scripts/data-wrangler-comparison-neutral-driver.test.mjs",
  "scripts/data-wrangler-comparison-study.mjs",
  "scripts/data-wrangler-comparison-study.test.mjs",
  "scripts/linux-pss-sampler.mjs",
  "scripts/linux-pss-sampler.test.mjs",
  "src/test/dataWranglerComparisonNotebookTrial.unit.test.ts",
  "src/test/extensionHost/dataWranglerComparisonNotebookTrial.ts"
]);
const BENCHMARK_HARNESS_PATH_SET = new Set(BENCHMARK_HARNESS_PATHS);
export const RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS = Object.freeze([
  "scripts/candidate-acceptance-workflow.mjs",
  "scripts/canonical-release-assets.mjs",
  "scripts/create-canonical-release-artifact.mjs",
  "scripts/download-canonical-github-release.mjs",
  "scripts/github-release-publisher.mjs",
  "scripts/marketplace-identity-profile.mjs",
  "scripts/marketplace-promotion-workflow.mjs",
  "scripts/marketplace-release-intake.mjs",
  "scripts/open-vsx-promotion-workflow.mjs",
  "scripts/package-current-channel.mjs",
  "scripts/prepare-stable-candidate-tag.mjs",
  "scripts/preview-release-workflow.mjs",
  "scripts/public-media-contract.mjs",
  "scripts/public-media-inventory.mjs",
  "scripts/public-media-surface-contract.mjs",
  "scripts/public-repository-metadata.mjs",
  "scripts/publish-github-preview-release.mjs",
  "scripts/publish-github-stable-release.mjs",
  "scripts/push-stable-release-tag.mjs",
  "scripts/registry-release-source.mjs",
  "scripts/release-diagnostic-order.mjs",
  "scripts/release-documents.mjs",
  "scripts/release-metadata.mjs",
  "scripts/release-notes.mjs",
  "scripts/release-readiness.mjs",
  "scripts/release-tag-publisher.mjs",
  "scripts/stable-release-workflow.mjs",
  "scripts/verify-canonical-release-artifact.mjs",
  "scripts/verify-marketplace-publication.mjs",
  "scripts/verify-open-vsx-release.mjs",
  "scripts/verify-preview-release-artifact.mjs",
  "scripts/verify-public-media-surfaces.mjs",
  "scripts/verify-registry-release-artifact.mjs"
]);
export const RELEASE_INFRASTRUCTURE_TEST_PATHS = Object.freeze([
  "scripts/candidate-acceptance-workflow.test.mjs",
  "scripts/create-canonical-release-artifact.test.mjs",
  "scripts/download-canonical-github-release.test.mjs",
  "scripts/marketplace-identity-profile.test.mjs",
  "scripts/marketplace-promotion-workflow.test.mjs",
  "scripts/marketplace-release-intake.test.mjs",
  "scripts/open-vsx-promotion-workflow.test.mjs",
  "scripts/package-current-channel.test.mjs",
  "scripts/prepare-stable-candidate-tag.test.mjs",
  "scripts/public-media-surfaces.test.mjs",
  "scripts/public-repository-metadata.test.mjs",
  "scripts/publish-github-stable-release.test.mjs",
  "scripts/push-stable-release-tag.test.mjs",
  "scripts/readme-media.test.mjs",
  "scripts/registry-release-source.test.mjs",
  "scripts/release-readiness.test.mjs",
  "scripts/stable-release-workflow.test.mjs",
  "scripts/verify-canonical-release-artifact.test.mjs",
  "scripts/verify-marketplace-publication.test.mjs",
  "scripts/verify-open-vsx-release.test.mjs",
  "scripts/verify-registry-release-artifact.test.mjs"
]);
export const RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS = Object.freeze([
  "CHANGELOG.md",
  "README.md",
  "docs/ci.md",
  "docs/media-gallery.md",
  "docs/media-spec-v1.2.md",
  "docs/releasing.md",
  "docs/testing.md"
]);
export const RELEASE_INFRASTRUCTURE_SHARED_DEPENDENCY_PATHS = Object.freeze([
  "scripts/data-wrangler-comparison-report.mjs",
  "scripts/package-source-manifest.mjs",
  "scripts/reproducible-vsix.mjs",
  "scripts/run-installed-performance.mjs",
  "scripts/strict-json.mjs",
  "scripts/vsix-archive.mjs",
  "scripts/vsix-contents.mjs"
]);
const RELEASE_INFRASTRUCTURE_PRIMARY_PATH_SET = new Set([
  ...RELEASE_INFRASTRUCTURE_PRODUCTION_PATHS,
  ...RELEASE_INFRASTRUCTURE_TEST_PATHS
]);
const RELEASE_INFRASTRUCTURE_ALLOWED_PATH_SET = new Set([
  ...RELEASE_INFRASTRUCTURE_PRIMARY_PATH_SET,
  ...RELEASE_INFRASTRUCTURE_ADJUNCT_DOCUMENT_PATHS
]);

function isCanonicalRepositoryPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return false;
  const segments = path.split("/");
  return !(path.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === ".."));
}

function isDocumentationOnlyPath(path) {
  if (!isCanonicalRepositoryPath(path)) return false;
  if (path.startsWith("docs/images/") || path === "docs/media-gallery.md" || path.startsWith("docs/media-spec-")) {
    return false;
  }
  if (ROOT_NON_PACKAGED_DOCUMENTATION.has(path) || path.startsWith("docs/")) return true;
  return (
    path.startsWith(".github/ISSUE_TEMPLATE/") ||
    path.startsWith(".github/PULL_REQUEST_TEMPLATE/") ||
    path === ".github/PULL_REQUEST_TEMPLATE.md" ||
    path === ".github/pull_request_template.md"
  );
}

export function isDocumentationOnlyChangeSet({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  if (eventName !== "pull_request") return false;
  return changedPaths.length > 0 && changedPaths.every((path) => isDocumentationOnlyPath(path));
}

export function isPackageOnlyChangeSet({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  if (eventName !== "pull_request") return false;
  return (
    changedPaths.length > 0 &&
    changedPaths.every((path) => isCanonicalRepositoryPath(path) && PACKAGED_DOCUMENT_PATHS.has(path))
  );
}

export function isDependencyLockOnlyChangeSet({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  return eventName === "pull_request" && changedPaths.length === 1 && changedPaths[0] === "package-lock.json";
}

export function isBenchmarkHarnessOnlyChangeSet({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  if (eventName !== "pull_request") return false;
  return (
    changedPaths.length > 0 &&
    changedPaths.every((path) => isCanonicalRepositoryPath(path) && BENCHMARK_HARNESS_PATH_SET.has(path))
  );
}

export function isReleaseInfrastructureOnlyChangeSet({ eventName, changedPaths }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  if (eventName !== "pull_request") return false;
  return (
    changedPaths.length > 0 &&
    changedPaths.some((path) => RELEASE_INFRASTRUCTURE_PRIMARY_PATH_SET.has(path)) &&
    changedPaths.every((path) => isCanonicalRepositoryPath(path) && RELEASE_INFRASTRUCTURE_ALLOWED_PATH_SET.has(path))
  );
}

export function parsePullRequestDraft({ eventName, value }) {
  if (eventName === "pull_request") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("Pull-request draft state must be exactly true or false.");
  }
  if (value !== undefined && value !== "") {
    throw new Error("Non-pull-request events must not carry pull-request draft state.");
  }
  return false;
}

export function classifyCiChange({ eventName, changedPaths, pullRequestDraft }) {
  if (!Array.isArray(changedPaths)) throw new TypeError("changedPaths must be an array.");
  const draftPullRequest = parsePullRequestDraft({ eventName, value: pullRequestDraft });
  const documentationOnly = isDocumentationOnlyChangeSet({ eventName, changedPaths });
  const packageOnly = isPackageOnlyChangeSet({ eventName, changedPaths });
  const dependencyLockOnly = isDependencyLockOnlyChangeSet({ eventName, changedPaths });
  const releaseInfrastructureOnly =
    !draftPullRequest &&
    !documentationOnly &&
    !packageOnly &&
    !dependencyLockOnly &&
    isReleaseInfrastructureOnlyChangeSet({ eventName, changedPaths });
  const benchmarkHarnessOnly =
    !draftPullRequest &&
    !documentationOnly &&
    !packageOnly &&
    !dependencyLockOnly &&
    !releaseInfrastructureOnly &&
    isBenchmarkHarnessOnlyChangeSet({ eventName, changedPaths });
  const lightweightOnly = documentationOnly || draftPullRequest;
  const fullMatrixRequired =
    !benchmarkHarnessOnly &&
    !documentationOnly &&
    !packageOnly &&
    !dependencyLockOnly &&
    !releaseInfrastructureOnly &&
    !draftPullRequest;
  return {
    benchmarkHarnessOnly,
    dependencyLockOnly,
    documentationOnly,
    draftPullRequest,
    lightweightOnly,
    packageOnly,
    releaseInfrastructureOnly,
    fullMatrixRequired
  };
}

export function parseChangedPathBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError("Changed paths must be provided as a Buffer.");
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new Error("The changed-path list must be NUL terminated.");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const paths = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index === start) throw new Error("The changed-path list contains an empty path.");
    paths.push(decoder.decode(buffer.subarray(start, index)));
    start = index + 1;
  }
  return paths;
}

function readPullRequestPaths({ baseSha, headSha }) {
  if (!COMMIT_SHA.test(baseSha ?? "") || !COMMIT_SHA.test(headSha ?? "")) {
    throw new Error("Pull-request base and head revisions must be exact lowercase commit SHAs.");
  }
  const output = execFileSync(
    "git",
    ["diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", baseSha, headSha, "--"],
    {
      cwd: process.cwd(),
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"]
    }
  );
  return parseChangedPathBuffer(output);
}

function main(environment) {
  const eventName = environment.CI_EVENT_NAME;
  if (!["pull_request", "push", "schedule", "workflow_dispatch"].includes(eventName)) {
    throw new Error(`Unsupported CI event: ${eventName || "missing"}.`);
  }
  const changedPaths =
    eventName === "pull_request"
      ? readPullRequestPaths({ baseSha: environment.CI_BASE_SHA, headSha: environment.CI_HEAD_SHA })
      : [];
  const classification = classifyCiChange({
    eventName,
    changedPaths,
    pullRequestDraft: environment.CI_PR_DRAFT
  });
  const outputPath = environment.GITHUB_OUTPUT;
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(
    outputPath,
    [
      `documentation_only=${classification.documentationOnly}`,
      `benchmark_harness_only=${classification.benchmarkHarnessOnly}`,
      `dependency_lock_only=${classification.dependencyLockOnly}`,
      `draft_pull_request=${classification.draftPullRequest}`,
      `lightweight_only=${classification.lightweightOnly}`,
      `package_only=${classification.packageOnly}`,
      `release_infrastructure_only=${classification.releaseInfrastructureOnly}`,
      `full_matrix_required=${classification.fullMatrixRequired}`,
      ""
    ].join("\n"),
    "utf8"
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  try {
    main(process.env);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "CI path classification failed."}\n`);
    process.exitCode = 1;
  }
}
