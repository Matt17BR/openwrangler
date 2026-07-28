import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectMarketplacePromotionPipeline, inspectMarketplaceVsceLock } from "./marketplace-promotion-workflow.mjs";

const source = readFileSync(new URL("../azure-pipelines-marketplace.yml", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
const packageLock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");

test("Marketplace promotion pipeline is the reviewed exact-artifact WIF flow", () => {
  assert.deepEqual(inspectMarketplacePromotionPipeline(source), []);
});

test("Marketplace promotion inspector rejects credentials, rebuilding, and promotion drift", () => {
  const mutations = [
    source.replace('      - "v*"', '      - "main"'),
    source.replace("pr: none", "pr:\n  branches:\n    include:\n      - main"),
    source.replace("default: openwrangler-marketplace-publishing", "default: arbitrary-connection"),
    source.replace('    default: ""', '    default: "v1.0.1"'),
    source.replace("lockBehavior: sequential", "lockBehavior: runLatest"),
    source.replace("environment: openwrangler-marketplace-publishing", "environment: unprotected"),
    source.replace("persistCredentials: false", "persistCredentials: true"),
    source.replace("npm ci --ignore-scripts", "npm ci --ignore-scripts && npm run build"),
    source.replace(
      "node scripts/download-canonical-github-release.mjs canonical-release",
      "curl -L https://example.com/openwrangler.vsix -o canonical-release/openwrangler.vsix"
    ),
    source.replace(
      "node scripts/verify-registry-release-artifact.mjs canonical-release",
      "node scripts/verify-vsix.mjs canonical-release/openwrangler.vsix"
    ),
    source.replace("AzureCLI@2", "AzureCLI@1"),
    source.replace(
      "azureSubscription: ${{ parameters.marketplaceServiceConnection }}",
      "azureSubscription: arbitraryServiceConnection"
    ),
    source.replace("addSpnToEnvironment: false", "addSpnToEnvironment: true"),
    source.replace("node scripts/marketplace-identity-profile.mjs", "echo unknown-marketplace-profile"),
    source.replace(
      "node scripts/marketplace-identity-profile.mjs\n                      npx --no-install vsce verify-pat Matt17BR --azure-credential",
      "npx --no-install vsce verify-pat Matt17BR --azure-credential\n                      node scripts/marketplace-identity-profile.mjs"
    ),
    source.replace(
      "npx --no-install vsce verify-pat Matt17BR --azure-credential",
      "npx --no-install vsce verify-pat Matt17BR --pat $(VSCE_PAT)"
    ),
    source.replace(
      "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --skip-duplicate",
      "npx --no-install vsce publish --pat $(VSCE_PAT) --packagePath canonical-release/openwrangler.vsix"
    ),
    source.replace(
      "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --pre-release --skip-duplicate",
      "npx --no-install vsce publish --azure-credential --packagePath canonical-release/openwrangler.vsix --skip-duplicate"
    ),
    source.replace("BUILD_REASON: $(Build.Reason)", "BUILD_REASON: Manual"),
    source.replace("EXPECTED_SHA: $(releaseCommit)", "EXPECTED_SHA: $(Build.SourceVersion)"),
    source.replace("node scripts/verify-marketplace-publication.mjs canonical-release", "echo published"),
    source.replace(
      "condition: and(succeeded(), eq(dependencies.Intake.outputs['Bind.release_intake.promote'], 'true'))",
      "condition: succeededOrFailed()"
    ),
    `${source}\n# drift\n`
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notEqual(candidate, source, `mutation ${index + 1} must change the pipeline`);
    assert.notDeepEqual(inspectMarketplacePromotionPipeline(candidate), [], `mutation ${index + 1} must fail`);
  }
});

test("Marketplace promotion uses one exact integrity-pinned VSCE package", () => {
  assert.deepEqual(inspectMarketplaceVsceLock({ packageJson, packageLock }), []);
});

test("Marketplace VSCE lock inspector rejects dependency range, tarball, and integrity drift", () => {
  const mutations = [
    {
      packageJson: packageJson.replace('"@vscode/vsce": "^3.9.1"', '"@vscode/vsce": "^4.0.0"'),
      packageLock
    },
    {
      packageJson,
      packageLock: packageLock.replace(
        "https://registry.npmjs.org/@vscode/vsce/-/vsce-3.9.1.tgz",
        "https://example.com/vsce-3.9.1.tgz"
      )
    },
    {
      packageJson,
      packageLock: packageLock.replace(
        "sha512-MPn5p+DoudI+3GfJSpAZZraE1lgLv0LcwbH3+xy7RgEhty3UIkmUMUA+5jPTDaxXae00AnX5u77FxGM8FhfKKA==",
        "sha512-invalid"
      )
    }
  ];
  for (const [index, candidate] of mutations.entries()) {
    assert.notDeepEqual(inspectMarketplaceVsceLock(candidate), [], `dependency mutation ${index + 1} must fail`);
  }
});
