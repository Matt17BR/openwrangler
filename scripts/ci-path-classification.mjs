import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const ROOT_NON_PACKAGED_DOCUMENTATION = new Set(["AGENTS.md", "CONTRIBUTING.md", "SECURITY.md", "SUPPORT.md"]);

function isDocumentationOnlyPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) return false;
  const segments = path.split("/");
  if (path.startsWith("/") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
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
  const lightweightOnly = documentationOnly || draftPullRequest;
  return {
    documentationOnly,
    draftPullRequest,
    lightweightOnly,
    releasedJupyterRequired: eventName === "pull_request" && !lightweightOnly
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

export function requiresReleasedJupyter({ eventName, changedPaths, pullRequestDraft }) {
  if (eventName === "push") return false;
  if (eventName !== "pull_request") throw new Error(`Unsupported CI event: ${eventName || "missing"}.`);
  return classifyCiChange({ eventName, changedPaths, pullRequestDraft }).releasedJupyterRequired;
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
      `draft_pull_request=${classification.draftPullRequest}`,
      `lightweight_only=${classification.lightweightOnly}`,
      `released_jupyter_required=${classification.releasedJupyterRequired}`,
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
