import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function proveDocsOnly({ cwd = process.cwd(), env = process.env } = {}) {
  const { CI_EVENT, CI_BASE_REF, CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA } = env;
  if (
    CI_EVENT !== "pull_request" ||
    CI_BASE_REF !== "main" ||
    ![CI_BASE_SHA, CI_HEAD_SHA, CI_MERGE_SHA].every((sha) => typeof sha === "string" && /^[0-9a-f]{40}$/u.test(sha))
  ) {
    return false;
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
    if (identity !== `${CI_MERGE_SHA}\n${CI_BASE_SHA} ${CI_HEAD_SHA}`) return false;
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
    return false;
  }

  const text = diff.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(diff)) return false;
  const records = text.split("\0");
  if (records.pop() !== "" || records.length === 0 || records.length % 2 !== 0) return false;
  for (let index = 0; index < records.length; index += 2) {
    // Only existing regular Markdown edits qualify; additions/deletions also exclude renames.
    if (!/^:100644 100644 [0-9a-f]{40} [0-9a-f]{40} M$/u.test(records[index])) return false;
    const path = records[index + 1];
    if (path !== "README.md" && !/^docs\/[^\p{Cc}]+\.md$/u.test(path)) return false;
  }
  return true;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 2) throw new Error("The CI documentation proof takes no arguments.");
  const docsOnly = proveDocsOnly();
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
  console.log(docsOnly ? "Verified existing documentation edits only." : "Full runtime checks required.");
}
