import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectMarketplacePromotionPipeline, inspectMarketplaceVsceLock } from "./marketplace-promotion-workflow.mjs";

const source = readFileSync(new URL("../azure-pipelines-marketplace.yml", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const packageLock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");

test("Marketplace promotion consumes the tagged GitHub release without main-branch polling", () => {
  assert.deepEqual(inspectMarketplacePromotionPipeline(source), []);
  assert.doesNotMatch(source, /branches:\s+include:\s+- main/u);
  assert.match(source, /OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 30/u);
  assert.match(source, /OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS: 10000/u);
  assert.match(source, /OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: 330000/u);
});

test("Marketplace promotion rejects trigger, wait, identity, rebuild, and byte-verification drift", () => {
  const cases = [
    source.replace('branches:\n    exclude:\n      - "*"', "branches:\n    include:\n      - main"),
    source.replace("OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 30", "OPEN_WRANGLER_GITHUB_RELEASE_ATTEMPTS: 210"),
    source.replace("OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS: 10000", "OPEN_WRANGLER_GITHUB_RELEASE_DELAY_MS: 60000"),
    source.replace(
      "OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: 330000",
      "OPEN_WRANGLER_GITHUB_RELEASE_TIMEOUT_MS: 3600000"
    ),
    source.replace("timeoutInMinutes: 6", "timeoutInMinutes: 60"),
    source.replace("timeoutInMinutes: 60", "timeoutInMinutes: 240"),
    source.replace("environment: openwrangler-marketplace-publishing", "environment: unprotected"),
    source.replace("AzureCLI@2", "AzureCLI@1"),
    source.replace("addSpnToEnvironment: false", "addSpnToEnvironment: true"),
    source.replace("node scripts/verify-registry-release-artifact.mjs canonical-release", "npm run build"),
    source.replace("--skip-duplicate", "--force"),
    source.replace("node scripts/verify-marketplace-publication.mjs canonical-release", "echo published")
  ];
  for (const [index, candidate] of cases.entries()) {
    assert.notEqual(candidate, source);
    assert.notDeepEqual(inspectMarketplacePromotionPipeline(candidate), [], `mutation ${index + 1}`);
  }
});

test("Marketplace publishing uses the ordinary lockfile-owned VSCE package", () => {
  assert.deepEqual(inspectMarketplaceVsceLock({ packageJson, packageLock }), []);
  assert.notDeepEqual(
    inspectMarketplaceVsceLock({
      packageJson,
      packageLock: packageLock.replace("https://registry.npmjs.org/@vscode/vsce/", "https://example.com/")
    }),
    []
  );
});
