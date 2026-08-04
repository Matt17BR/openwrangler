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
    releaseProtectedBranchRef: "refs/heads/main",
    remoteTagCommit: commit,
    resolvedTagCommit: commit,
    sourceBranch: "refs/tags/v1.0.2",
    sourceCommit: commit,
    ...overrides
  };
}

function protectedReleaseBranch(overrides = {}) {
  const releaseCommit = "b".repeat(40);
  const currentManifest = manifest({ version: "1.2.3" });
  return automatic({
    buildReason: "IndividualCI",
    currentProtectedBranchCommit: commit,
    currentPackageJson: currentManifest,
    recoveryChange: {
      changedPaths: ["scripts/marketplace-release-intake.mjs"],
      parentCommits: ["d".repeat(40)]
    },
    releasePackageJson: currentManifest,
    remoteTagCommit: releaseCommit,
    resolvedTagCommit: releaseCommit,
    sourceBranch: "refs/heads/main",
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

test("Marketplace intake manually recovers v1.2.2 directly from its immutable tag", () => {
  const historicalCommit = "b".repeat(40);
  assert.deepEqual(
    inspectMarketplaceReleaseIntake(
      automatic({
        buildReason: "Manual",
        currentProtectedBranchCommit: commit,
        existingReleaseTag: "v1.2.2",
        releasePackageJson: manifest({ version: "1.2.2" }),
        remoteTagCommit: historicalCommit,
        resolvedTagCommit: historicalCommit,
        releaseContainedInProtectedBranch: false,
        releaseProtectedBranchRef: undefined,
        sourceBranch: "refs/heads/main"
      })
    ),
    {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: historicalCommit,
      releaseTag: "v1.2.2",
      version: "1.2.2"
    }
  );
});

test("Marketplace intake does not automatically republish v1.2.2 after a main change", () => {
  const v122 = manifest({ version: "1.2.2" });
  const result = inspectMarketplaceReleaseIntake(
    protectedReleaseBranch({
      currentPackageJson: v122,
      releasePackageJson: v122
    })
  );
  assert.deepEqual(result, {
    eligible: false,
    noOpReason: "historical-release",
    prerelease: undefined,
    problems: [],
    promote: false,
    releaseCommit: undefined,
    releaseTag: "v1.2.2",
    version: "1.2.2"
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "Version 1.2.2 was released before releases had to come from main. Automatic recovery skipped it; recover it manually by selecting its existing release tag."
  ]);
});

test("Marketplace intake requires releases after v1.2.2 to be contained in main", () => {
  const historicalCommit = "b".repeat(40);
  for (const candidate of [
    automatic({
      releaseContainedInProtectedBranch: false,
      releasePackageJson: manifest({ version: "1.2.3" }),
      sourceBranch: "refs/tags/v1.2.3"
    }),
    automatic({
      releaseContainedInProtectedBranch: undefined,
      releasePackageJson: manifest({ version: "1.2.3" }),
      sourceBranch: "refs/tags/v1.2.3"
    }),
    automatic({
      releasePackageJson: manifest({ version: "1.2.3" }),
      releaseProtectedBranchRef: undefined,
      sourceBranch: "refs/tags/v1.2.3"
    }),
    automatic({
      buildReason: "Manual",
      currentProtectedBranchCommit: commit,
      existingReleaseTag: "v1.2.3",
      releaseContainedInProtectedBranch: false,
      releasePackageJson: manifest({ version: "1.2.3" }),
      remoteTagCommit: historicalCommit,
      resolvedTagCommit: historicalCommit,
      sourceBranch: "refs/heads/main"
    })
  ]) {
    const rejected = inspectMarketplaceReleaseIntake(candidate);
    assert.equal(rejected.eligible, false);
    assert.match(rejected.problems.join("\n"), /contained in protected main/u);
  }
});

test("Marketplace intake rejects annotated and conflicting automatic public tags", () => {
  for (const remoteTagCommit of ["b".repeat(40), "c".repeat(40), undefined]) {
    const rejected = inspectMarketplaceReleaseIntake(automatic({ remoteTagCommit }));
    assert.equal(rejected.eligible, false);
    assert.match(rejected.problems.join("\n"), /one exact public lightweight tag commit/u);
  }
});

test("Marketplace intake automatically recovers the current tagged package from main", () => {
  for (const buildReason of ["IndividualCI", "BatchedCI"]) {
    assert.deepEqual(inspectMarketplaceReleaseIntake(protectedReleaseBranch({ buildReason })), {
      eligible: true,
      prerelease: false,
      problems: [],
      promote: true,
      releaseCommit: "b".repeat(40),
      releaseTag: "v1.2.3",
      version: "1.2.3"
    });
  }
});

test("Marketplace recovery uses main for current v1 and v2 releases", () => {
  assert.equal(inspectMarketplaceReleaseIntake(protectedReleaseBranch()).eligible, true);
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

test("Marketplace main-branch recovery is a clean no-op when the current version has no tag", () => {
  const result = inspectMarketplaceReleaseIntake(
    protectedReleaseBranch({
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
    releaseTag: "v1.2.3",
    version: "1.2.3"
  });
  assert.deepEqual(marketplaceReleaseIntakeOutput(result), [
    "##vso[task.setvariable variable=promote;isOutput=true]false",
    "No immutable release tag v1.2.3 exists for the current package version; main-branch recovery completed without Marketplace promotion."
  ]);
});

test("Marketplace main-branch recovery ignores ordinary and ambiguous changes", () => {
  for (const [recoveryChange, noOpReason, message] of [
    [
      { changedPaths: ["README.md", "src/webviews/App.tsx"], parentCommits: ["d".repeat(40)] },
      "irrelevant-paths",
      "The main commit changed no reviewed Marketplace recovery path; promotion was not queued."
    ],
    [
      {
        changedPaths: ["scripts/marketplace-release-intake.mjs"],
        parentCommits: ["d".repeat(40), "e".repeat(40)]
      },
      "ambiguous-history",
      "The main commit was not a single-parent change; automatic recovery completed without promotion."
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

test("Marketplace main-branch recovery rejects stale automation, unsafe reasons, and tag drift", () => {
  const releaseCommit = "b".repeat(40);
  for (const candidate of [
    protectedReleaseBranch({ currentProtectedBranchCommit: "c".repeat(40) }),
    protectedReleaseBranch({ checkedOutCommit: "c".repeat(40) }),
    protectedReleaseBranch({ buildReason: "Schedule" }),
    protectedReleaseBranch({ remoteTagCommit: "c".repeat(40) }),
    protectedReleaseBranch({ remoteTagCommit: undefined }),
    protectedReleaseBranch({ resolvedTagCommit: undefined }),
    protectedReleaseBranch({
      currentPackageJson: manifest({ version: "1.2.4" }),
      releasePackageJson: manifest({ version: "1.2.3" })
    }),
    protectedReleaseBranch({
      currentPackageJson: manifest({ version: "1.2.3" }),
      releasePackageJson: manifest({ version: "1.2.4" }),
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
