import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectReleaseMetadata } from "./release-metadata.mjs";

const FULL_COMMIT = /^[0-9a-f]{40}$/u;
const TAG_REF = /^refs\/tags\/(?<tag>v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/u;

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

export function inspectMarketplaceReleaseIntake({ packageJson, sourceBranch, sourceCommit, checkedOutCommit }) {
  const problems = [];
  const match = typeof sourceBranch === "string" ? TAG_REF.exec(sourceBranch) : null;
  if (match === null) {
    problems.push("Marketplace promotion accepts only a canonical numeric Git tag ref.");
  }
  if (
    typeof sourceCommit !== "string" ||
    !FULL_COMMIT.test(sourceCommit) ||
    typeof checkedOutCommit !== "string" ||
    checkedOutCommit !== sourceCommit
  ) {
    problems.push("The Azure Pipeline checkout must equal the immutable tag event commit.");
  }
  const releaseTag = match?.groups?.tag;
  const metadata = inspectReleaseMetadata({ packageJson, releaseTag });
  problems.push(...metadata.problems);
  const eligible =
    problems.length === 0 &&
    metadata.prerelease === false &&
    typeof metadata.version === "string" &&
    !metadata.version.startsWith("0.");
  return Object.freeze({
    eligible,
    problems: Object.freeze(problems),
    releaseTag,
    version: metadata.version
  });
}

function runCli() {
  const root = resolve(import.meta.dirname, "..");
  const result = inspectMarketplaceReleaseIntake({
    checkedOutCommit: exactHead(root),
    packageJson: readFileSync(resolve(root, "package.json"), "utf8"),
    sourceBranch: process.env.BUILD_SOURCEBRANCH,
    sourceCommit: process.env.BUILD_SOURCEVERSION
  });
  if (result.problems.length > 0) {
    throw new Error(`Marketplace release intake failed:\n- ${result.problems.join("\n- ")}`);
  }
  const value = result.eligible ? "true" : "false";
  console.log(`##vso[task.setvariable variable=stable;isOutput=true]${value}`);
  console.log(
    result.eligible
      ? `Accepted stable Marketplace promotion ${result.releaseTag}.`
      : `Skipped preview Marketplace promotion ${result.releaseTag}.`
  );
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli();
}
