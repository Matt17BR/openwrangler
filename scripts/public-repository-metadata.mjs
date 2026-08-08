import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const marketplace = "https://marketplace.visualstudio.com/items?itemName=Matt17BR.openwrangler";
const repositoryApi = "https://api.github.com/repos/Matt17BR/openwrangler";

export function inspectPublicRepositoryMetadata({ contractSource, packageSource }) {
  let metadata;
  let packageJson;
  try {
    metadata = JSON.parse(contractSource);
    packageJson = JSON.parse(packageSource);
  } catch {
    return ["Repository metadata and package.json must contain valid JSON."];
  }

  const problems = [];
  if (Object.keys(metadata).sort().join() !== "description,homepage,topics")
    problems.push("Repository metadata must contain only description, homepage, and topics.");
  if (metadata.description !== packageJson.description)
    problems.push("GitHub About description must match package.json description.");
  if (metadata.homepage !== marketplace)
    problems.push("GitHub About homepage must point to the Visual Studio Marketplace listing.");
  const topics = metadata.topics;
  if (
    !Array.isArray(topics) ||
    topics.length === 0 ||
    topics.length > 20 ||
    topics.some((topic) => typeof topic !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(topic)) ||
    new Set(topics).size !== topics.length ||
    JSON.stringify([...topics].sort()) !== JSON.stringify(topics)
  ) {
    problems.push("GitHub About topics must be normalized, unique, sorted, and contain at most 20 entries.");
  }
  return problems;
}

export async function verifyLivePublicRepositoryMetadata(metadata, fetchImpl = fetch) {
  const response = await fetchImpl(repositoryApi, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "openwrangler-metadata-check" }
  });
  if (!response.ok) throw new Error(`GitHub metadata check failed with HTTP ${response.status}.`);
  const live = await response.json();
  const liveTopics = Array.isArray(live.topics) ? [...live.topics].sort() : live.topics;
  if (
    live.description !== metadata.description ||
    live.homepage !== metadata.homepage ||
    JSON.stringify(liveTopics) !== JSON.stringify(metadata.topics)
  ) {
    throw new Error("GitHub About metadata differs from .github/repository-metadata.json.");
  }
}

async function main() {
  if (process.argv.length !== 3 || !["--local", "--live"].includes(process.argv[2])) {
    throw new Error("Usage: node scripts/public-repository-metadata.mjs --local|--live");
  }
  const contractSource = readFileSync(resolve(root, ".github/repository-metadata.json"), "utf8");
  const packageSource = readFileSync(resolve(root, "package.json"), "utf8");
  const problems = inspectPublicRepositoryMetadata({ contractSource, packageSource });
  if (problems.length > 0) throw new Error(problems.join("\n"));
  const metadata = JSON.parse(contractSource);
  if (process.argv[2] === "--live") await verifyLivePublicRepositoryMetadata(metadata);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.dirname, "public-repository-metadata.mjs")) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
