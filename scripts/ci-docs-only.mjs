import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const runtimeOmissionScriptFiles = new Set([
  "scripts/capture-screenshots.mjs",
  "scripts/capture-screenshots-readiness.mjs",
  "scripts/release-metadata.mjs",
  "scripts/daily-preview-artifact.mjs",
  "scripts/daily-preview-artifact.test.mjs",
  "scripts/prepare-stable-candidate-tag.mjs",
  "scripts/prepare-stable-candidate-tag.test.mjs",
  "scripts/release-tag-publisher.mjs",
  "scripts/push-stable-release-tag.mjs",
  "scripts/push-stable-release-tag.test.mjs",
  "scripts/publish-github-stable-release.mjs",
  "scripts/publish-github-stable-release.test.mjs",
  "scripts/verify-canonical-release-artifact.mjs",
  "scripts/verify-canonical-release-artifact.test.mjs"
]);

export function proveRuntimeOmissions({ cwd = process.cwd(), env = process.env } = {}) {
  const required = { docsOnly: false, rOmittable: false, pythonOmittable: false };
  const { CI_EVENT, CI_BASE_REF, CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA } = env;
  if (
    CI_EVENT !== "pull_request" ||
    CI_BASE_REF !== "main" ||
    ![CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha))
  ) {
    return required;
  }

  let identity;
  let diff;
  try {
    const git = (args) =>
      execFileSync("git", args, {
        cwd,
        timeout: 15_000,
        maxBuffer: 256 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    identity = git(["show", "--no-patch", "--format=%H%n%P", "HEAD"]).toString("ascii").trim();
    if (identity !== `${CI_MERGE_SHA}\n${CI_BASE_SHA} ${CI_HEAD_SHA}`) return required;
    diff = git([
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      CI_BASE_SHA,
      CI_MERGE_SHA,
      "--"
    ]);
  } catch {
    // Missing history, failed Git commands, and oversized output require the full owners.
    return required;
  }

  const text = diff.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(diff)) return required;
  const records = text.split("\0");
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return required;
  let docsOnly = true;
  let rOmittable = true;
  let pythonOmittable = true;
  for (let index = 0; index < records.length; index += 2) {
    const modified = /^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M$/u.test(records[index]);
    const path = records[index + 1];
    const pythonSource = /^python\/(?:openwrangler_runtime|tests)\/[^\p{Cc}]+\.py$/u.test(path);
    const rSource = /^r\/(?:openwrangler_runtime|tests)\/[^\p{Cc}]+\.R$/u.test(path);
    // Only regular runtime/test source additions may omit the other runtime; deletions still exclude renames.
    if (!modified && !((pythonSource || rSource) && /^:000000 100644 0{40} [0-9a-f]{40} A$/u.test(records[index]))) {
      return required;
    }
    if (modified && (path === "README.md" || path === "CHANGELOG.md" || /^docs\/[^\p{Cc}]+\.md$/u.test(path))) continue;
    docsOnly = false;
    if (
      modified &&
      (/^src\/test\/[^/\p{Cc}]+\.component\.test\.tsx$/u.test(path) || runtimeOmissionScriptFiles.has(path))
    )
      continue;
    if (pythonSource) {
      pythonOmittable = false;
      continue;
    }
    if (
      rSource ||
      (modified &&
        (/^src\/test\/extensionHost\/[^/\p{Cc}]+\.ts$/u.test(path) ||
          path === "scripts/editor-acceptance.mjs" ||
          path === "scripts/editor-acceptance-artifact.test.mjs"))
    ) {
      rOmittable = false;
      continue;
    }
    return required;
  }
  return { docsOnly, rOmittable, pythonOmittable };
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("The CI documentation proof takes no arguments.");
  const { docsOnly, rOmittable, pythonOmittable } = proveRuntimeOmissions();
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `docs_only=${docsOnly}\nr_omittable=${rOmittable}\npython_omittable=${pythonOmittable}\n`
  );
  console.log(
    docsOnly
      ? "Verified existing documentation edits only."
      : rOmittable && pythonOmittable
        ? "Verified edits permit omission of Python, R and Windows runtime checks."
        : rOmittable
          ? "Verified changes independent of native R."
          : pythonOmittable
            ? "Verified changes independent of Python."
            : "Full runtime checks required."
  );
}
