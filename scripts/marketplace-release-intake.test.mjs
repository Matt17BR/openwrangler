import assert from "node:assert/strict";
import test from "node:test";
import { inspectMarketplaceReleaseIntake } from "./marketplace-release-intake.mjs";

const commit = "a".repeat(40);

function manifest({ preview = false, version = "1.0.2" } = {}) {
  return JSON.stringify({
    name: "openwrangler",
    publisher: "Matt17BR",
    preview,
    version
  });
}

test("Marketplace intake accepts an exact stable tag checkout", () => {
  assert.deepEqual(
    inspectMarketplaceReleaseIntake({
      checkedOutCommit: commit,
      packageJson: manifest(),
      sourceBranch: "refs/tags/v1.0.2",
      sourceCommit: commit
    }),
    {
      eligible: true,
      problems: [],
      releaseTag: "v1.0.2",
      version: "1.0.2"
    }
  );
});

test("Marketplace intake safely skips a valid preview tag", () => {
  assert.deepEqual(
    inspectMarketplaceReleaseIntake({
      checkedOutCommit: commit,
      packageJson: manifest({ preview: true, version: "0.3.0" }),
      sourceBranch: "refs/tags/v0.3.0",
      sourceCommit: commit
    }),
    {
      eligible: false,
      problems: [],
      releaseTag: "v0.3.0",
      version: "0.3.0"
    }
  );
});

test("Marketplace intake rejects branches, tag drift, and checkout drift", () => {
  const branch = inspectMarketplaceReleaseIntake({
    checkedOutCommit: commit,
    packageJson: manifest(),
    sourceBranch: "refs/heads/main",
    sourceCommit: commit
  });
  assert.equal(branch.eligible, false);
  assert.match(branch.problems.join("\n"), /only a canonical numeric Git tag ref|does not match package version/u);

  const tag = inspectMarketplaceReleaseIntake({
    checkedOutCommit: commit,
    packageJson: manifest(),
    sourceBranch: "refs/tags/v1.0.3",
    sourceCommit: commit
  });
  assert.equal(tag.eligible, false);
  assert.match(tag.problems.join("\n"), /does not match package version/u);

  const checkout = inspectMarketplaceReleaseIntake({
    checkedOutCommit: "b".repeat(40),
    packageJson: manifest(),
    sourceBranch: "refs/tags/v1.0.2",
    sourceCommit: commit
  });
  assert.equal(checkout.eligible, false);
  assert.match(checkout.problems.join("\n"), /checkout must equal/u);
});
