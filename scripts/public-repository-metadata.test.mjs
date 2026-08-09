import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { inspectPublicRepositoryMetadata, verifyLivePublicRepositoryMetadata } from "./public-repository-metadata.mjs";

const metadata = JSON.parse(readFileSync(resolve(import.meta.dirname, "../.github/repository-metadata.json"), "utf8"));
const packageSource = readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8");
const packageJson = JSON.parse(packageSource);
const inspect = (candidate, candidatePackageSource = packageSource) =>
  inspectPublicRepositoryMetadata({ contractSource: JSON.stringify(candidate), packageSource: candidatePackageSource });

test("local validation rejects description, homepage, and topic drift", () => {
  assert.deepEqual(inspect(metadata), []);
  assert.match(inspect({ ...metadata, description: "stale" }).join(" "), /description/u);
  assert.match(inspect({ ...metadata, homepage: "https://github.com/Matt17BR/openwrangler" }).join(" "), /homepage/u);
  assert.match(
    inspect(
      metadata,
      JSON.stringify({ ...packageJson, homepage: "https://github.com/Matt17BR/openwrangler#readme" })
    ).join(" "),
    /extension homepage/u
  );
  assert.match(inspect({ ...metadata, topics: [...metadata.topics].reverse() }).join(" "), /topics/u);
});

test("live validation accepts an exact response and rejects drift", async () => {
  const response = (value) => async () => new Response(JSON.stringify(value), { status: 200 });
  await verifyLivePublicRepositoryMetadata(metadata, response(metadata));
  for (const changed of [
    { ...metadata, description: "stale" },
    { ...metadata, homepage: "https://example.com" },
    { ...metadata, topics: metadata.topics.slice(1) }
  ]) {
    await assert.rejects(verifyLivePublicRepositoryMetadata(metadata, response(changed)), /differs/u);
  }
});
