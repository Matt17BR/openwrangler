import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import test from "node:test";
import {
  inspectMarketplaceRecoveryChange,
  inspectMarketplaceRecoverySource,
  inspectMarketplaceReleaseIntake,
  MARKETPLACE_RECOVERY_PATHS,
  marketplaceReleaseIntakeOutput
} from "./marketplace-release-intake.mjs";

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
    currentProtectedBranchCommit: "c".repeat(40),
    currentPackageJson: manifest(),
    existingReleaseTag: "",
    releaseContainedInProtectedBranch: true,
    releasePackageJson: manifest(),
    releaseProtectedBranchRef: "refs/heads/release/1.x",
    remoteTagCommit: commit,
    resolvedTagCommit: commit,
    sourceBranch: "refs/tags/v1.0.2",
    sourceCommit: commit,
    ...overrides
  };
}

function protectedReleaseBranch(overrides = {}) {
  const releaseCommit = "b".repeat(40);
  return automatic({
    buildReason: "IndividualCI",
    currentProtectedBranchCommit: commit,
    currentPackageJson: manifest(),
    recoveryChange: {
      changedPaths: ["scripts/marketplace-release-intake.mjs"],
      parentCommits: ["d".repeat(40)]
    },
    releasePackageJson: manifest(),
    remoteTagCommit: releaseCommit,
    resolvedTagCommit: releaseCommit,
    sourceBranch: "refs/heads/release/1.x",
    ...overrides
  });
}

function marketplaceRuntimeClosure() {
  const pending = [
    "scripts/download-canonical-github-release.mjs",
    "scripts/marketplace-identity-profile.mjs",
    "scripts/marketplace-release-intake.mjs",
    "scripts/verify-marketplace-publication.mjs",
    "scripts/verify-registry-release-artifact.mjs"
  ];
  const closure = new Set();
  while (pending.length > 0) {
    const module = pending.pop();
    if (module === undefined || closure.has(module)) {
      continue;
    }
    assert.ok(closure.size < 128, "Marketplace runtime closure must remain bounded");
    closure.add(module);
    const sourceBytes = readFileSync(new URL(`../${module}`, import.meta.url));
    assert.ok(sourceBytes.byteLength <= 2 * 1024 * 1024, `${module} must remain bounded`);
    const source = sourceBytes.toString("utf8");
    const specifiers = [
      ...source.matchAll(/(?:from\s+|import\s+)["'](?<specifier>\.{1,2}\/[^"']+)["']/gu),
      ...source.matchAll(/require\(\s*["'](?<specifier>\.{1,2}\/[^"']+)["']\s*\)/gu)
    ].map((match) => match.groups?.specifier);
    assert.ok(specifiers.length <= 256, `${module} must have a bounded local dependency count`);
    for (const specifier of specifiers) {
      assert.match(specifier ?? "", /^\.\.?\/[A-Za-z0-9_./-]+\.(?:cjs|mjs)$/u);
      assert.ok(Buffer.byteLength(specifier ?? "", "utf8") <= 4096);
      const dependency = posix.normalize(posix.join(posix.dirname(module), specifier));
      assert.doesNotMatch(dependency, /^(?:\.\.?\/|\/)/u);
      pending.push(dependency);
    }
  }
  return [...closure].sort();
}

test("Marketplace recovery runs only for an exact single-parent reviewed infrastructure change", () => {
  const expectedPaths = [
    "azure-pipelines-marketplace.yml",
    "package-lock.json",
    "package.json",
    "scripts/bounded-file-read.mjs",
    "scripts/canonical-release-assets.mjs",
    "scripts/copy-extension-test-runtime-assets.mjs",
    "scripts/cursor-acquisition.mjs",
    "scripts/download-canonical-github-release.mjs",
    "scripts/editor-acceptance-evidence.mjs",
    "scripts/editor-acceptance.mjs",
    "scripts/installed-performance-report.mjs",
    "scripts/installed-performance-system.mjs",
    "scripts/marketplace-identity-profile.mjs",
    "scripts/marketplace-release-intake.mjs",
    "scripts/packaged-editor-orchestration.mjs",
    "scripts/prepare-xvfb.mjs",
    "scripts/public-media-contract.mjs",
    "scripts/release-metadata.mjs",
    "scripts/remote-workspace-acquisition.mjs",
    "scripts/remote-workspace-contract.mjs",
    "scripts/run-installed-performance.mjs",
    "scripts/strict-json.mjs",
    "scripts/verify-canonical-release-artifact.mjs",
    "scripts/verify-marketplace-publication.mjs",
    "scripts/verify-registry-release-artifact.mjs",
    "scripts/vsix-archive.mjs",
    "scripts/vsix-contents.mjs",
    "src/shared/installedPerformanceFixtureManifest.cjs",
    "src/shared/strictJson.cjs"
  ];
  assert.deepEqual(MARKETPLACE_RECOVERY_PATHS, expectedPaths);
  assert.deepEqual(expectedPaths, [
    "azure-pipelines-marketplace.yml",
    "package-lock.json",
    "package.json",
    ...marketplaceRuntimeClosure()
  ]);
  for (const changedPath of expectedPaths) {
    assert.deepEqual(
      inspectMarketplaceRecoveryChange({
        changedPaths: [changedPath],
        parentCommits: ["d".repeat(40)]
      }),
      { problems: [], reason: undefined, relevant: true }
    );
  }
  assert.deepEqual(
    inspectMarketplaceRecoveryChange({
      changedPaths: ["README.md", "src/extension/extension.ts"],
      parentCommits: ["d".repeat(40)]
    }),
    { problems: [], reason: "irrelevant-paths", relevant: false }
  );
  assert.deepEqual(
    inspectMarketplaceRecoveryChange({
      changedPaths: ["scripts/marketplace-release-intake.mjs"],
      parentCommits: ["d".repeat(40), "e".repeat(40)]
    }),
    { problems: [], reason: "ambiguous-history", relevant: false }
  );
  assert.notEqual(
    inspectMarketplaceRecoveryChange({
      changedPaths: ["scripts\\marketplace-release-intake.mjs"],
      parentCommits: ["d".repeat(40)]
    }).problems.length,
    0
  );
  assert.notEqual(
    inspectMarketplaceRecoveryChange({
      changedPaths: Array.from({ length: 4097 }, (_, index) => `path-${index}`),
      parentCommits: ["d".repeat(40)]
    }).problems.length,
    0
  );
  assert.notEqual(
    inspectMarketplaceRecoveryChange({
      changedPaths: Array.from({ length: 513 }, (_, index) => `${String(index).padStart(4, "0")}${"x".repeat(4091)}`),
      parentCommits: ["d".repeat(40)]
    }).problems.length,
    0
  );
});

test("Marketplace recovery derives only the canonical package identity and numeric version", () => {
  assert.deepEqual(inspectMarketplaceRecoverySource(manifest()), {
    problems: [],
    releaseTag: "v1.0.2",
    version: "1.0.2"
  });
  for (const packageJson of [
    "{",
    manifest({ version: "1.0.2-beta.1" }),
    JSON.stringify({ name: "other", preview: false, publisher: "Matt17BR", version: "1.0.2" }),
    manifest({ preview: true })
  ]) {
    assert.notEqual(inspectMarketplaceRecoverySource(packageJson).problems.length, 0);
  }
});

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
        releaseProtectedBranchRef: "refs/heads/main",
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

test("Marketplace intake keeps a historical v1.2 ancestor valid on a later maintenance-branch head", () => {
  const historicalCommit = "b".repeat(40);
  assert.deepEqual(
    inspectMarketplaceReleaseIntake(
      automatic({
        buildReason: "Manual",
        currentProtectedBranchCommit: commit,
        existingReleaseTag: "v1.2.0",
        releasePackageJson: manifest({ version: "1.2.0" }),
        remoteTagCommit: historicalCommit,
        resolvedTagCommit: historicalCommit,
        sourceBranch: "refs/heads/release/1.x"
      })
    ),
    {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: historicalCommit,
      releaseTag: "v1.2.0",
      version: "1.2.0"
    }
  );
});

test("Marketplace intake rejects matching-metadata commits outside the version-owned branch", () => {
  const historicalCommit = "b".repeat(40);
  for (const candidate of [
    automatic({ releaseContainedInProtectedBranch: false }),
    automatic({ releaseContainedInProtectedBranch: undefined }),
    automatic({ releaseProtectedBranchRef: "refs/heads/main" }),
    automatic({
      buildReason: "Manual",
      currentProtectedBranchCommit: commit,
      existingReleaseTag: "v1.2.0",
      releaseContainedInProtectedBranch: false,
      releasePackageJson: manifest({ version: "1.2.0" }),
      remoteTagCommit: historicalCommit,
      resolvedTagCommit: historicalCommit,
      sourceBranch: "refs/heads/release/1.x"
    })
  ]) {
    const rejected = inspectMarketplaceReleaseIntake(candidate);
    assert.equal(rejected.eligible, false);
    assert.match(rejected.problems.join("\n"), /contained in its current version-owned protected branch/u);
  }
});

test("Marketplace intake rejects annotated and conflicting automatic public tags", () => {
  for (const remoteTagCommit of ["b".repeat(40), "c".repeat(40), undefined]) {
    const rejected = inspectMarketplaceReleaseIntake(automatic({ remoteTagCommit }));
    assert.equal(rejected.eligible, false);
    assert.match(rejected.problems.join("\n"), /one exact public lightweight tag commit/u);
  }
});

test("Marketplace intake automatically recovers the current tagged package from its protected branch", () => {
  for (const buildReason of ["IndividualCI", "BatchedCI"]) {
    assert.deepEqual(inspectMarketplaceReleaseIntake(protectedReleaseBranch({ buildReason })), {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: "b".repeat(40),
      releaseTag: "v1.0.2",
      version: "1.0.2"
    });
  }
});

test("Marketplace recovery is branch-owned across the v1 and v2 boundary", () => {
  const inactive = inspectMarketplaceReleaseIntake(
    protectedReleaseBranch({
      currentProtectedBranchCommit: undefined,
      remoteTagCommit: undefined,
      resolvedTagCommit: undefined,
      sourceBranch: "refs/heads/main"
    })
  );
  assert.deepEqual(inactive, {
    eligible: false,
    noOpReason: "inactive-branch",
    prerelease: undefined,
    problems: [],
    promote: false,
    releaseCommit: undefined,
    releaseTag: "v1.0.2",
    version: "1.0.2"
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(inactive), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "This protected branch does not own the current package version; Marketplace recovery was not queued."
  ]);

  const v2 = manifest({ version: "2.0.0" });
  assert.deepEqual(
    inspectMarketplaceReleaseIntake(
      protectedReleaseBranch({
        currentPackageJson: v2,
        releasePackageJson: v2,
        releaseProtectedBranchRef: "refs/heads/main",
        sourceBranch: "refs/heads/main"
      })
    ),
    {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: "b".repeat(40),
      releaseTag: "v2.0.0",
      version: "2.0.0"
    }
  );
});

test("Marketplace protected release-branch recovery is a clean no-op when the current version has no tag", () => {
  const result = inspectMarketplaceReleaseIntake(
    protectedReleaseBranch({
      releasePackageJson: manifest(),
      remoteTagCommit: undefined,
      resolvedTagCommit: undefined
    })
  );
  assert.deepEqual(result, {
    eligible: false,
    noOpReason: "missing-tag",
    prerelease: undefined,
    problems: [],
    promote: false,
    releaseCommit: undefined,
    releaseTag: "v1.0.2",
    version: "1.0.2"
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "No immutable release tag v1.0.2 exists for the current package version; protected release-branch recovery completed without Marketplace promotion."
  ]);
});

test("Marketplace protected release-branch recovery ignores ordinary and ambiguous changes", () => {
  for (const [recoveryChange, noOpReason, message] of [
    [
      { changedPaths: ["README.md", "src/webviews/App.tsx"], parentCommits: ["d".repeat(40)] },
      "irrelevant-paths",
      "The protected release-branch commit changed no reviewed Marketplace recovery path; promotion was not queued."
    ],
    [
      {
        changedPaths: ["scripts/marketplace-release-intake.mjs"],
        parentCommits: ["d".repeat(40), "e".repeat(40)]
      },
      "ambiguous-history",
      "The protected release-branch commit was not a single-parent change; automatic recovery safely completed without promotion."
    ]
  ]) {
    const result = inspectMarketplaceReleaseIntake(
      protectedReleaseBranch({
        currentProtectedBranchCommit: undefined,
        currentPackageJson: "{not inspected for an irrelevant change",
        recoveryChange,
        releasePackageJson: "{not inspected for an irrelevant change",
        remoteTagCommit: undefined,
        resolvedTagCommit: undefined
      })
    );
    assert.deepEqual(result, {
      eligible: false,
      noOpReason,
      prerelease: undefined,
      problems: [],
      promote: false,
      releaseCommit: undefined,
      releaseTag: undefined,
      version: undefined
    });
    assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
      "##vso[task.setvariable variable=promote;isOutput=true]false",
      message
    ]);
  }
});

test("Marketplace intake makes only an empty default protected-branch run a successful no-op", () => {
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
    noOpReason: "manual-empty",
    prerelease: undefined,
    problems: [],
    promote: false,
    releaseCommit: undefined,
    releaseTag: undefined,
    version: undefined
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "No release tag was selected; the default manual protected-branch run completed without Marketplace promotion."
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
      currentProtectedBranchCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      remoteTagCommit: "b".repeat(40),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({
      buildReason: "Manual",
      currentProtectedBranchCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      remoteTagCommit: "b".repeat(40),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/release"
    }),
    automatic({
      buildReason: "Manual",
      currentProtectedBranchCommit: commit,
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.3" }),
      remoteTagCommit: "b".repeat(40),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({
      buildReason: "Manual",
      currentProtectedBranchCommit: "c".repeat(40),
      existingReleaseTag: "v1.0.1",
      releasePackageJson: manifest({ version: "1.0.1" }),
      remoteTagCommit: "b".repeat(40),
      resolvedTagCommit: "b".repeat(40),
      sourceBranch: "refs/heads/main"
    }),
    automatic({ resolvedTagCommit: "b".repeat(40) }),
    automatic({ checkedOutCommit: "b".repeat(40) })
  ]) {
    assert.equal(inspectMarketplaceReleaseIntake(candidate).eligible, false);
  }
});

test("Marketplace protected release-branch recovery rejects stale automation, unsafe reasons, and tag drift", () => {
  const releaseCommit = "b".repeat(40);
  for (const candidate of [
    protectedReleaseBranch({ currentProtectedBranchCommit: "c".repeat(40) }),
    protectedReleaseBranch({ checkedOutCommit: "c".repeat(40) }),
    protectedReleaseBranch({ buildReason: "Schedule" }),
    protectedReleaseBranch({ remoteTagCommit: "c".repeat(40) }),
    protectedReleaseBranch({ remoteTagCommit: undefined }),
    protectedReleaseBranch({ resolvedTagCommit: undefined }),
    protectedReleaseBranch({
      currentPackageJson: manifest({ version: "1.0.3" }),
      releasePackageJson: manifest({ version: "1.0.2" })
    }),
    protectedReleaseBranch({
      currentPackageJson: manifest({ version: "1.0.2" }),
      releasePackageJson: manifest({ version: "1.0.1" }),
      remoteTagCommit: releaseCommit,
      resolvedTagCommit: releaseCommit
    })
  ]) {
    const rejected = inspectMarketplaceReleaseIntake(candidate);
    assert.equal(rejected.eligible, false);
    assert.notEqual(rejected.problems.length, 0);
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
