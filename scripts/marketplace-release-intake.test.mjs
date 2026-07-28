import assert from "node:assert/strict";
import test from "node:test";
import { inspectMarketplaceReleaseIntake, marketplaceReleaseIntakeOutput } from "./marketplace-release-intake.mjs";

const commit = "a".repeat(40);

function manifest({ preview = false, version = "1.0.2" } = {}) {
  return JSON.stringify({
    name: "openwrangler",
    publisher: "Matt17BR",
    preview,
    version
  });
}

function automatic(overrides = {}) {
  return {
    buildReason: "IndividualCI",
    checkedOutCommit: commit,
    currentMainCommit: undefined,
    existingReleaseTag: "",
    releasePackageJson: manifest(),
    resolvedTagCommit: commit,
    sourceBranch: "refs/tags/v1.0.2",
    sourceCommit: commit,
    ...overrides
  };
}

test("Marketplace intake accepts exact automatic stable and pre-release tag checkouts", () => {
  assert.deepEqual(inspectMarketplaceReleaseIntake(automatic()), {
    eligible: true,
    prerelease: false,
    problems: [],
    promote: true,
    releaseCommit: commit,
    releaseTag: "v1.0.2",
    version: "1.0.2"
  });

  assert.deepEqual(
    inspectMarketplaceReleaseIntake(
      automatic({
        releasePackageJson: manifest({ preview: true, version: "0.3.0" }),
        sourceBranch: "refs/tags/v0.3.0"
      })
    ),
    {
      eligible: true,
      prerelease: true,
      problems: [],
      promote: true,
      releaseCommit: commit,
      releaseTag: "v0.3.0",
      version: "0.3.0"
    }
  );
});

test("Marketplace intake accepts a manual historical release from current protected main", () => {
  const historicalCommit = "b".repeat(40);
  assert.deepEqual(
    inspectMarketplaceReleaseIntake(
      automatic({
        buildReason: "Manual",
        currentMainCommit: commit,
        existingReleaseTag: "v1.0.1",
        releasePackageJson: manifest({ version: "1.0.1" }),
        resolvedTagCommit: historicalCommit,
        sourceBranch: "refs/heads/main"
      })
    ),
    {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: historicalCommit,
      releaseTag: "v1.0.1",
      version: "1.0.1"
    }
  );
});

test("Marketplace intake makes only the empty default manual main run a successful no-op", () => {
  const result = inspectMarketplaceReleaseIntake(
    automatic({
      buildReason: "Manual",
      releasePackageJson: "{not parsed for a no-op",
      resolvedTagCommit: undefined,
      sourceBranch: "refs/heads/main"
    })
  );
  assert.deepEqual(result, {
    eligible: false,
    prerelease: undefined,
    problems: [],
    promote: false,
    releaseCommit: undefined,
    releaseTag: undefined,
    version: undefined
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "No release tag was selected; the default manual main run completed without Marketplace promotion."
  ]);

  for (const candidate of [
    automatic({ buildReason: "IndividualCI", resolvedTagCommit: undefined, sourceBranch: "refs/heads/main" }),
    automatic({ buildReason: "Schedule", resolvedTagCommit: undefined, sourceBranch: "refs/heads/main" }),
    automatic({ buildReason: "Manual", resolvedTagCommit: undefined, sourceBranch: "refs/heads/release" }),
    automatic({
      buildReason: "Manual",
      checkedOutCommit: "b".repeat(40),
      resolvedTagCommit: undefined,
      sourceBranch: "refs/heads/main"
    })
  ]) {
    const rejected = inspectMarketplaceReleaseIntake(candidate);
    assert.equal(rejected.eligible, false);
    assert.equal(rejected.promote, false);
    assert.notEqual(rejected.problems.length, 0);
  }
});

test("Marketplace intake rejects unsafe historical source selection and tag drift", () => {
  for (const candidate of [
    automatic({
      buildReason: "IndividualCI",
      currentMainCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({
      buildReason: "Manual",
      currentMainCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/release"
    }),
    automatic({
      buildReason: "Manual",
      currentMainCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.3" }),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({
      buildReason: "Manual",
      currentMainCommit: "c".repeat(40),
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({ resolvedTagCommit: "b".repeat(40) }),
    automatic({ checkedOutCommit: "b".repeat(40) })
  ]) {
    assert.equal(inspectMarketplaceReleaseIntake(candidate).eligible, false);
  }
});

test("Marketplace intake rejects a wrong package identity or channel declaration", () => {
  const identity = inspectMarketplaceReleaseIntake(
    automatic({
      releasePackageJson: JSON.stringify({
        name: "other",
        publisher: "Matt17BR",
        preview: false,
        version: "1.0.2"
      })
    })
  );
  assert.equal(identity.eligible, false);
  assert.match(identity.problems.join("\n"), /Matt17BR\.openwrangler/u);

  const channel = inspectMarketplaceReleaseIntake(
    automatic({ releasePackageJson: manifest({ preview: false, version: "0.3.0" }), sourceBranch: "refs/tags/v0.3.0" })
  );
  assert.equal(channel.eligible, false);
  assert.match(channel.problems.join("\n"), /requires package\.json "preview" to be true/u);
});
