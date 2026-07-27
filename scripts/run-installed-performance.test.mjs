import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { readFileSync, renameSync, writeFileSync } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  assertExtensionTestOutputTreeSafe,
  copyExtensionTestRuntimeAssets,
  EXTENSION_TEST_COMPILED_MODULES,
  EXTENSION_TEST_RUNTIME_ASSETS,
  verifyExtensionTestRuntimeAssets
} from "./copy-extension-test-runtime-assets.mjs";
import { EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL, editorProcessTreeMayBeLive } from "./editor-acceptance.mjs";
import {
  acceptInstalledPerformanceCandidate,
  acquirePinnedInstalledPerformanceEditors,
  assertInstalledPerformanceArtifactPathSeparation,
  assertInstalledPerformancePackageInventory,
  assertNoPackageableUntrackedFiles,
  assertSameInstalledPerformancePackageSources,
  cleanupInstalledPerformancePrivateRoot,
  collectInstalledPerformanceEditorRuns,
  installInstalledPerformanceCandidate,
  installedPerformanceDisplayMode,
  installedPerformanceReportGateForOptions,
  PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
  PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
  PERFORMANCE_EVIDENCE_ARTIFACT_ROLE,
  packageInstalledPerformanceCandidate as packageInstalledPerformanceCandidateImplementation,
  parseInstalledPerformanceArguments,
  prepareInstalledPerformanceCandidate,
  publishInstalledPerformanceReleaseResult,
  readBoundedJson,
  readInstalledPerformanceChecksum,
  readInstalledPerformanceFragment,
  readInstalledPerformanceCandidate,
  readInstalledPerformanceProvenance,
  readPerformanceEvidenceProvenance,
  readInstalledPerformanceSourceManifest,
  readInstalledPerformanceVsixReceipt,
  revalidateInstalledPerformanceChecksum,
  revalidateInstalledPerformanceProvenance,
  revalidatePerformanceEvidenceProvenance,
  revalidateInstalledPerformanceVsix,
  resolveInstalledPerformanceEditors,
  runInstalledMeasuredEditorPhase,
  stageInstalledPerformanceVsix,
  validateInstalledPerformanceProvenance,
  validateInstalledPerformanceSourceManifest,
  validatePerformanceEvidenceProvenance,
  writeInstalledPerformanceRun
} from "./run-installed-performance.mjs";

test("extension-test builds explicitly stage declaration-shadowed CommonJS runtime assets", async () => {
  assert.deepEqual(EXTENSION_TEST_RUNTIME_ASSETS, [
    {
      source: "src/shared/installedPerformanceFixtureManifest.cjs",
      output: "dist-test/shared/installedPerformanceFixtureManifest.cjs"
    },
    {
      source: "src/shared/strictJson.cjs",
      output: "dist-test/shared/strictJson.cjs"
    }
  ]);
  assert.deepEqual(EXTENSION_TEST_COMPILED_MODULES, [
    "dist-test/test/extensionHost/installedPerformance.js",
    "dist-test/test/extensionHost/identifiedTemporary.js",
    "dist-test/test/extensionHost/progress.js"
  ]);
  const packageManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageManifest.scripts["build:test-extension"],
    "node scripts/copy-extension-test-runtime-assets.mjs --guard-output-tree && tsc -p tsconfig.extension-test.json && node scripts/copy-extension-test-runtime-assets.mjs"
  );
  const compilerConfiguration = JSON.parse(
    readFileSync(new URL("../tsconfig.extension-test.json", import.meta.url), "utf8")
  );
  assert.equal(compilerConfiguration.include.includes("src/shared/installedPerformanceFixtureManifest.cjs"), false);
  assert.equal(compilerConfiguration.include.includes("src/shared/strictJson.cjs"), false);
  assert.ok(compilerConfiguration.include.includes("src/shared/installedPerformanceFixtureManifest.d.cts"));
  assert.ok(compilerConfiguration.include.includes("src/shared/strictJson.d.cts"));
  const installedPerformanceRunner = readFileSync(new URL("./run-installed-performance.mjs", import.meta.url), "utf8");
  assert.match(
    installedPerformanceRunner,
    /for \(const phase of INSTALLED_PERFORMANCE_PHASES\) \{\s+verifyExtensionTestRuntimeAssets\(\);/u
  );

  const directory = await mkdtemp(join(tmpdir(), "openwrangler-extension-test-assets-"));
  try {
    for (const [index, asset] of EXTENSION_TEST_RUNTIME_ASSETS.entries()) {
      const source = join(directory, asset.source);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, `module.exports = { value: ${index} };\n`, { flag: "wx", mode: 0o600 });
    }
    const entrypoint = join(directory, "dist-test/test/extensionHost/installedPerformance.js");
    await mkdir(dirname(entrypoint), { recursive: true });
    await mkdir(join(directory, "dist-test/shared"), { recursive: true });
    await writeFile(
      entrypoint,
      [
        'require("../../shared/installedPerformanceFixtureManifest.cjs");',
        'require("../../shared/strictJson.cjs");',
        'require("./identifiedTemporary");',
        'require("./progress");',
        "exports.run = async function run() {};",
        ""
      ].join("\n"),
      { flag: "wx", mode: 0o600 }
    );
    for (const helper of EXTENSION_TEST_COMPILED_MODULES.slice(1)) {
      await writeFile(join(directory, helper), "module.exports = {};\n", { flag: "wx", mode: 0o600 });
    }

    copyExtensionTestRuntimeAssets({ root: directory });
    verifyExtensionTestRuntimeAssets({ root: directory });
    for (const asset of EXTENSION_TEST_RUNTIME_ASSETS) {
      assert.deepEqual(readFileSync(join(directory, asset.output)), readFileSync(join(directory, asset.source)));
    }

    for (const asset of EXTENSION_TEST_RUNTIME_ASSETS) {
      await rm(join(directory, asset.output));
      assert.throws(
        () => verifyExtensionTestRuntimeAssets({ root: directory }),
        /Extension-test output .* is missing/u
      );
      copyExtensionTestRuntimeAssets({ root: directory });
    }

    await writeFile(join(directory, EXTENSION_TEST_RUNTIME_ASSETS[1].output), "module.exports = {};\n");
    assert.throws(() => verifyExtensionTestRuntimeAssets({ root: directory }), /does not match/u);
    copyExtensionTestRuntimeAssets({ root: directory });

    for (const helper of EXTENSION_TEST_COMPILED_MODULES.slice(1)) {
      await rm(join(directory, helper));
      assert.throws(
        () => verifyExtensionTestRuntimeAssets({ root: directory }),
        /Extension-test compiled module .* is missing/u
      );
      await writeFile(join(directory, helper), "module.exports = {};\n", { flag: "wx", mode: 0o600 });
    }

    const replacedHelper = join(directory, EXTENSION_TEST_COMPILED_MODULES[1]);
    const priorHelper = `${replacedHelper}.prior`;
    assert.throws(
      () =>
        verifyExtensionTestRuntimeAssets({
          root: directory,
          spawnPreflight() {
            renameSync(replacedHelper, priorHelper);
            writeFileSync(replacedHelper, readFileSync(priorHelper), { flag: "wx", mode: 0o600 });
            fs.rmSync(priorHelper);
            return {
              error: undefined,
              signal: null,
              status: 0,
              stderr: "",
              stdout: JSON.stringify(
                [...EXTENSION_TEST_COMPILED_MODULES, ...EXTENSION_TEST_RUNTIME_ASSETS.map(({ output }) => output)]
                  .map((path) => join(directory, path))
                  .sort()
              )
            };
          }
        }),
      /compiled module .* changed during its load preflight/u
    );

    await rm(entrypoint);
    assert.throws(
      () => verifyExtensionTestRuntimeAssets({ root: directory }),
      /Extension-test compiled module .* is missing/u
    );
    await writeFile(
      entrypoint,
      ['require("../../shared/future-runtime-dependency.cjs");', "exports.run = async function run() {};", ""].join(
        "\n"
      ),
      { flag: "wx", mode: 0o600 }
    );
    assert.throws(() => verifyExtensionTestRuntimeAssets({ root: directory }), /could not load without an editor/u);
    await writeFile(join(directory, "dist-test/shared/future-runtime-dependency.cjs"), "module.exports = {};\n", {
      flag: "wx",
      mode: 0o600
    });
    assert.throws(
      () => verifyExtensionTestRuntimeAssets({ root: directory }),
      /incomplete or unknown local-module closure/u
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("extension-test staging rejects linked output paths without touching their targets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwrangler-extension-test-links-"));
  const alias = `${directory}-alias`;
  try {
    for (const [index, asset] of EXTENSION_TEST_RUNTIME_ASSETS.entries()) {
      const source = join(directory, asset.source);
      await mkdir(dirname(source), { recursive: true });
      await writeFile(source, `module.exports = { value: ${index} };\n`, { flag: "wx", mode: 0o600 });
    }
    const entrypoint = join(directory, "dist-test/test/extensionHost/installedPerformance.js");
    await mkdir(dirname(entrypoint), { recursive: true });
    await writeFile(entrypoint, "exports.run = async function run() {};\n", { flag: "wx", mode: 0o600 });

    const outside = join(directory, "outside");
    const sentinel = join(outside, "sentinel.cjs");
    await mkdir(outside);
    await writeFile(sentinel, "do not overwrite\n", { flag: "wx", mode: 0o600 });
    const shared = join(directory, "dist-test/shared");
    await symlink(outside, shared, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => assertExtensionTestOutputTreeSafe({ root: directory }), /must not contain symbolic links/u);
    assert.throws(() => copyExtensionTestRuntimeAssets({ root: directory }), /must not contain symbolic links/u);
    assert.equal(readFileSync(sentinel, "utf8"), "do not overwrite\n");
    for (const asset of EXTENSION_TEST_RUNTIME_ASSETS) {
      assert.equal(fs.existsSync(join(outside, asset.output.split("/").at(-1))), false);
    }

    await rm(shared);
    await mkdir(shared);
    const firstOutput = join(directory, EXTENSION_TEST_RUNTIME_ASSETS[0].output);
    await symlink(sentinel, firstOutput);
    assert.throws(() => assertExtensionTestOutputTreeSafe({ root: directory }), /must not contain symbolic links/u);
    assert.throws(() => copyExtensionTestRuntimeAssets({ root: directory }), /must not contain symbolic links/u);
    assert.equal(readFileSync(sentinel, "utf8"), "do not overwrite\n");

    await rm(firstOutput);
    await link(sentinel, firstOutput);
    assert.throws(() => assertExtensionTestOutputTreeSafe({ root: directory }), /single-link regular files/u);
    assert.throws(() => copyExtensionTestRuntimeAssets({ root: directory }), /single-link regular files/u);
    assert.equal(readFileSync(sentinel, "utf8"), "do not overwrite\n");

    await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => assertExtensionTestOutputTreeSafe({ root: alias }),
      /repository root must be one canonical directory/u
    );
  } finally {
    await rm(alias, { force: true });
    await rm(directory, { force: true, recursive: true });
  }
});

const fakeFileIdentity = Object.freeze({
  dev: 1n,
  ino: 2n,
  size: 123n,
  mtimeNs: 3n,
  ctimeNs: 4n
});

function packageInstalledPerformanceCandidate(options) {
  return packageInstalledPerformanceCandidateImplementation({
    assertPackageSource: () => packageSourceReceipt(["package.json"]),
    verifyPackageInventory: () => {},
    ...options
  });
}

function archiveEntryForPackageFile(file) {
  const lower = file.toLowerCase();
  if (lower === "readme.md") return "extension/readme.md";
  if (lower === "changelog.md") return "extension/changelog.md";
  if (lower === "license" || lower === "license.txt" || lower === "license.md") return "extension/LICENSE.txt";
  return `extension/${file}`;
}

function packageFileReceipt({ path, sha256 = "a".repeat(64), identity = fakeFileIdentity }) {
  return Object.freeze({
    path,
    archiveEntry: archiveEntryForPackageFile(path),
    bytes: Number(identity.size),
    sha256,
    fileIdentity: identity
  });
}

function packageSourceReceipt(packageFiles, generatedFiles = [], trackedFiles = undefined) {
  const generatedPaths = new Set(generatedFiles.map(({ path }) => path));
  return Object.freeze({
    packageFiles: Object.freeze([...packageFiles].sort()),
    trackedFiles: Object.freeze(
      (trackedFiles ?? packageFiles.filter((path) => !generatedPaths.has(path)).map((path) => ({ path }))).map(
        packageFileReceipt
      )
    ),
    generatedFiles: Object.freeze(generatedFiles.map(packageFileReceipt))
  });
}

function archiveDigestsForPackageSource(receipt) {
  return [...receipt.trackedFiles, ...receipt.generatedFiles].map(({ archiveEntry, sha256 }) => [archiveEntry, sha256]);
}

function previewSourceManifest(overrides = {}) {
  return {
    publisher: "Matt17BR",
    name: "openwrangler",
    version: "0.3.0",
    preview: true,
    ...overrides
  };
}

function fakeVsixReceipt(path, sha256 = "b".repeat(64)) {
  return Object.freeze({
    path,
    sha256,
    bytes: 123,
    fileIdentity: fakeFileIdentity
  });
}

function fakeProvenanceReceipt(path = resolve("release", "openwrangler.vsix.provenance.json"), overrides = {}) {
  const receipt = {
    path,
    protocol: "openwrangler-canonical-release-artifact-v1",
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "1.0.0",
    preview: false,
    releaseTag: "v1.0.0",
    sourceCommit: "a".repeat(40),
    vsixSha256: "b".repeat(64),
    vsixBytes: 123,
    sha256: "d".repeat(64),
    bytes: 256,
    ...overrides
  };
  receipt.fileIdentity = overrides.fileIdentity ?? Object.freeze({ ...fakeFileIdentity, size: BigInt(receipt.bytes) });
  return Object.freeze(receipt);
}

function fakeEvidenceProvenanceReceipt(path = resolve("release", "openwrangler.vsix.provenance.json"), overrides = {}) {
  return fakeProvenanceReceipt(path, {
    protocol: PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
    artifactRole: PERFORMANCE_EVIDENCE_ARTIFACT_ROLE,
    ...overrides
  });
}

test("installed performance assigns unfocused release display modes per editor", () => {
  assert.equal(installedPerformanceDisplayMode({ key: "vscode" }, {}), "headless");
  assert.equal(installedPerformanceDisplayMode({ key: "cursor" }, {}), "xvfb");
  assert.equal(
    installedPerformanceDisplayMode({ key: "cursor" }, { OPEN_WRANGLER_EDITOR_DISPLAY: "current" }),
    "current"
  );
  assert.throws(
    () => installedPerformanceDisplayMode({ key: "vscode" }, { OPEN_WRANGLER_EDITOR_DISPLAY: "invalid" }),
    /headless.*xvfb.*current/u
  );
});

test("stable canonical evidence resolves only freshly acquired pinned VS Code and Cursor installations", async () => {
  const environment = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/session-bus",
    OPEN_WRANGLER_VSCODE_EXECUTABLE: "/untrusted/code",
    OPEN_WRANGLER_CURSOR_EXECUTABLE: "/untrusted/cursor"
  };
  const calls = [];
  const acquired = await acquirePinnedInstalledPerformanceEditors("/private/root", environment, {
    async acquireVscode(root) {
      calls.push(["vscode", root]);
      return {
        editor: {
          key: "vscode",
          executable: "/private/root/vscode/code",
          cli: "/private/root/vscode/bin/code"
        }
      };
    },
    async acquireCursor(root) {
      calls.push(["cursor", root]);
      return {
        editor: {
          key: "cursor",
          executable: "/private/root/cursor/cursor",
          cli: "/private/root/cursor/bin/cursor"
        }
      };
    }
  });
  assert.deepEqual(calls, [
    ["vscode", "/private/root"],
    ["cursor", "/private/root"]
  ]);
  assert.equal(acquired[0].editor.key, "vscode");
  assert.equal(acquired[1].editor.key, "cursor");
  assert.equal(environment.OPEN_WRANGLER_VSCODE_EXECUTABLE, "/private/root/vscode/code");
  assert.equal(environment.OPEN_WRANGLER_VSCODE_CLI, "/private/root/vscode/bin/code");
  assert.equal(environment.OPEN_WRANGLER_CURSOR_EXECUTABLE, "/private/root/cursor/cursor");
  assert.equal(environment.OPEN_WRANGLER_CURSOR_CLI, "/private/root/cursor/bin/cursor");
  await assert.rejects(
    acquirePinnedInstalledPerformanceEditors(
      "/private/root",
      {},
      {
        acquireVscode: async () => assert.fail("missing session bus must fail before acquisition"),
        acquireCursor: async () => assert.fail("missing session bus must fail before acquisition")
      }
    ),
    /isolated D-Bus session/u
  );

  const failedEnvironment = {
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/private/session-bus",
    OPEN_WRANGLER_VSCODE_EXECUTABLE: "/original/code"
  };
  let cursorSettled = false;
  await assert.rejects(
    acquirePinnedInstalledPerformanceEditors("/private/root", failedEnvironment, {
      acquireVscode: async () => {
        throw new Error("VS Code acquisition failed");
      },
      acquireCursor: async () => {
        await new Promise((resolvePromise) => setImmediate(resolvePromise));
        cursorSettled = true;
        return {
          editor: {
            key: "cursor",
            executable: "/private/root/cursor/cursor",
            cli: "/private/root/cursor/bin/cursor"
          }
        };
      }
    }),
    /VS Code acquisition failed/u
  );
  assert.equal(cursorSettled, true);
  assert.equal(failedEnvironment.OPEN_WRANGLER_VSCODE_EXECUTABLE, "/original/code");
  assert.equal(failedEnvironment.OPEN_WRANGLER_CURSOR_EXECUTABLE, undefined);
});

test("resolved stable editors never use a moving download fallback", async () => {
  const fixed = new Set(["/fixed/code", "/fixed/code-cli", "/fixed/cursor", "/fixed/cursor-cli"]);
  let downloads = 0;
  const environment = {
    OPEN_WRANGLER_VSCODE_EXECUTABLE: "/fixed/code",
    OPEN_WRANGLER_VSCODE_CLI: "/fixed/code-cli",
    OPEN_WRANGLER_CURSOR_EXECUTABLE: "/fixed/cursor",
    OPEN_WRANGLER_CURSOR_CLI: "/fixed/cursor-cli"
  };
  const editors = await resolveInstalledPerformanceEditors(["vscode", "cursor"], environment, {
    mode: "consume",
    pathExists: (path) => fixed.has(path),
    downloadVscode: async () => {
      downloads += 1;
      return "/downloaded/code";
    },
    downloadedCliPath: () => "/downloaded/code-cli"
  });
  assert.equal(downloads, 0);
  assert.deepEqual(
    editors.map(({ key, executable, cli }) => ({ key, executable, cli })),
    [
      { key: "vscode", executable: "/fixed/code", cli: "/fixed/code-cli" },
      { key: "cursor", executable: "/fixed/cursor", cli: "/fixed/cursor-cli" }
    ]
  );

  fixed.delete("/fixed/code");
  await assert.rejects(
    resolveInstalledPerformanceEditors(["vscode", "cursor"], environment, {
      mode: "consume",
      pathExists: (path) => fixed.has(path),
      downloadVscode: async () => {
        downloads += 1;
        return "/downloaded/code";
      },
      downloadedCliPath: () => "/downloaded/code-cli"
    }),
    /Stable canonical evidence requires fixed editor\(s\) were not found: vscode/u
  );
  assert.equal(downloads, 0);
});

test("preview installed performance retains its explicit VS Code download fallback", async () => {
  const existing = new Set(["/fixed/cursor", "/fixed/cursor-cli", "/downloaded/code", "/downloaded/code-cli"]);
  const requestedVersions = [];
  const editors = await resolveInstalledPerformanceEditors(
    ["vscode", "cursor"],
    {
      OPEN_WRANGLER_CURSOR_EXECUTABLE: "/fixed/cursor",
      OPEN_WRANGLER_CURSOR_CLI: "/fixed/cursor-cli",
      VSCODE_TEST_VERSION: "1.105.0"
    },
    {
      mode: "package",
      pathExists: (path) => existing.has(path),
      downloadVscode: async (version) => {
        requestedVersions.push(version);
        return "/downloaded/code";
      },
      downloadedCliPath: () => "/downloaded/code-cli"
    }
  );
  assert.deepEqual(requestedVersions, ["1.105.0"]);
  assert.deepEqual(
    editors.map(({ key, executable, cli }) => ({ key, executable, cli })),
    [
      { key: "vscode", executable: "/downloaded/code", cli: "/downloaded/code-cli" },
      { key: "cursor", executable: "/fixed/cursor", cli: "/fixed/cursor-cli" }
    ]
  );
});

test("process-tree uncertainty prevents every private-root receipt access and cleanup", () => {
  const error = new Error("surviving editor process group");
  error.details = { treeVerifiedStopped: false };
  const receipt = new Proxy(
    {},
    {
      get() {
        assert.fail("uncertain cleanup must not inspect the private-root receipt");
      }
    }
  );
  let cleanupCalls = 0;

  assert.equal(editorProcessTreeMayBeLive(error), true);
  assert.equal(
    cleanupInstalledPerformancePrivateRoot({
      processTreeUncertain: editorProcessTreeMayBeLive(error),
      receipt,
      removePrivateRoot() {
        cleanupCalls += 1;
      }
    }),
    false
  );
  assert.equal(cleanupCalls, 0);
});

test("installed performance arguments default to both first-class editors", () => {
  const parsed = parseInstalledPerformanceArguments([]);

  assert.equal(parsed.smoke, false);
  assert.equal(parsed.artifactKind, "stable-release");
  assert.deepEqual(parsed.editors, ["vscode", "cursor"]);
  assert.equal(parsed.mode, "package");
  assert.match(parsed.candidateOutput, /tmp[/\\]performance[/\\]openwrangler-installed-candidate\.vsix$/u);
  assert.match(parsed.output, /tmp[/\\]performance[/\\]installed-performance\.json$/u);
});

test("installed performance arguments support explicit smoke editor sharding", () => {
  const parsed = parseInstalledPerformanceArguments([
    "--smoke",
    "--editors",
    "vscode",
    "--candidate-out",
    "tmp/custom.vsix",
    "--out",
    "tmp/custom.json"
  ]);

  assert.equal(parsed.smoke, true);
  assert.deepEqual(parsed.editors, ["vscode"]);
  assert.equal(parsed.mode, "package");
  assert.match(parsed.candidateOutput, /tmp[/\\]custom\.vsix$/u);
  assert.match(parsed.output, /tmp[/\\]custom\.json$/u);
  assert.throws(
    () => parseInstalledPerformanceArguments(["--editors", "vscode,vscode"]),
    /unique comma-separated subset/u
  );
  assert.throws(() => parseInstalledPerformanceArguments(["--unknown"]), /Unknown installed-performance option/u);
  assert.throws(() => parseInstalledPerformanceArguments(["candidate.vsix"]), /requires named candidate options/u);
});

test("installed performance arguments make canonical candidate intake an exclusive stable mode", () => {
  const parsed = parseInstalledPerformanceArguments([
    "--pinned-editors",
    "--candidate-in",
    "release/openwrangler.vsix",
    "--candidate-checksum",
    "release/openwrangler.vsix.sha256",
    "--candidate-provenance",
    "release/openwrangler.vsix.provenance.json",
    "--out",
    "tmp/canonical.json"
  ]);

  assert.equal(parsed.mode, "consume");
  assert.equal(parsed.pinnedEditors, true);
  assert.equal(parsed.artifactKind, "stable-release");
  assert.equal(parsed.candidateOutput, undefined);
  assert.match(parsed.candidateInput, /release[/\\]openwrangler\.vsix$/u);
  assert.match(parsed.candidateChecksum, /release[/\\]openwrangler\.vsix\.sha256$/u);
  assert.match(parsed.candidateProvenance, /release[/\\]openwrangler\.vsix\.provenance\.json$/u);
  assert.deepEqual(parsed.editors, ["vscode", "cursor"]);
  const evidence = parseInstalledPerformanceArguments([
    "--pinned-editors",
    "--performance-evidence",
    "--candidate-in",
    "release/openwrangler.vsix",
    "--candidate-checksum",
    "release/openwrangler.vsix.sha256",
    "--candidate-provenance",
    "release/openwrangler.vsix.provenance.json"
  ]);
  assert.equal(evidence.artifactKind, PERFORMANCE_EVIDENCE_ARTIFACT_KIND);
  const releaseGate = () => "release";
  const evidenceGate = () => "evidence";
  assert.equal(installedPerformanceReportGateForOptions(evidence, { releaseGate, evidenceGate }), evidenceGate);
  assert.equal(installedPerformanceReportGateForOptions(parsed, { releaseGate, evidenceGate }), releaseGate);
  assert.throws(
    () => installedPerformanceReportGateForOptions({ artifactKind: "unknown" }, { releaseGate, evidenceGate }),
    /unknown artifact kind/u
  );
  assert.throws(
    () =>
      parseInstalledPerformanceArguments([
        "--candidate-in",
        "openwrangler.vsix",
        "--candidate-checksum",
        "openwrangler.vsix.sha256",
        "--candidate-provenance",
        "openwrangler.vsix.provenance.json"
      ]),
    /requires --pinned-editors/u
  );
  assert.throws(
    () => parseInstalledPerformanceArguments(["--pinned-editors", "--pinned-editors"]),
    /provided only once/u
  );
  assert.throws(
    () => parseInstalledPerformanceArguments(["--performance-evidence", "--performance-evidence"]),
    /provided only once/u
  );
  assert.throws(
    () => parseInstalledPerformanceArguments(["--pinned-editors"]),
    /reserved for canonical stable candidate consumption/u
  );
  assert.throws(
    () => parseInstalledPerformanceArguments(["--performance-evidence"]),
    /reserved for canonical candidate consumption/u
  );
  for (const incomplete of [
    ["--candidate-in", "openwrangler.vsix"],
    ["--candidate-checksum", "openwrangler.vsix.sha256"],
    ["--candidate-provenance", "openwrangler.vsix.provenance.json"],
    ["--candidate-in", "openwrangler.vsix", "--candidate-checksum", "openwrangler.vsix.sha256"],
    ["--candidate-in", "openwrangler.vsix", "--candidate-provenance", "openwrangler.vsix.provenance.json"],
    ["--candidate-checksum", "openwrangler.vsix.sha256", "--candidate-provenance", "openwrangler.vsix.provenance.json"]
  ]) {
    assert.throws(() => parseInstalledPerformanceArguments(incomplete), /required together/u);
  }
  assert.throws(
    () =>
      parseInstalledPerformanceArguments([
        "--candidate-in",
        "openwrangler.vsix",
        "--candidate-checksum",
        "openwrangler.vsix.sha256",
        "--candidate-provenance",
        "openwrangler.vsix.provenance.json",
        "--candidate-out",
        "copy.vsix"
      ]),
    /cannot be combined/u
  );
  for (const forbidden of [["--smoke"], ["--editors", "vscode"], ["--editors", "vscode,cursor"]]) {
    assert.throws(
      () =>
        parseInstalledPerformanceArguments([
          "--pinned-editors",
          "--candidate-in",
          "openwrangler.vsix",
          "--candidate-checksum",
          "openwrangler.vsix.sha256",
          "--candidate-provenance",
          "openwrangler.vsix.provenance.json",
          ...forbidden
        ]),
      /cannot use --smoke|cannot use --editors/u
    );
  }
  assert.throws(
    () =>
      parseInstalledPerformanceArguments([
        "--candidate-in",
        "one.vsix",
        "--candidate-in",
        "two.vsix",
        "--candidate-checksum",
        "openwrangler.vsix.sha256",
        "--candidate-provenance",
        "openwrangler.vsix.provenance.json"
      ]),
    /provided only once/u
  );
  assert.throws(
    () =>
      parseInstalledPerformanceArguments([
        "--candidate-in",
        "openwrangler.vsix",
        "--candidate-checksum",
        "openwrangler.vsix.sha256",
        "--candidate-provenance",
        "one.json",
        "--candidate-provenance",
        "two.json"
      ]),
    /provided only once/u
  );
  for (const [option, value] of [
    ["--candidate-checksum", "openwrangler.vsix"],
    ["--candidate-provenance", "openwrangler.vsix"],
    ["--candidate-provenance", "openwrangler.vsix.sha256"]
  ]) {
    assert.throws(
      () =>
        parseInstalledPerformanceArguments([
          "--pinned-editors",
          "--candidate-in",
          "openwrangler.vsix",
          "--candidate-checksum",
          option === "--candidate-checksum" ? value : "openwrangler.vsix.sha256",
          "--candidate-provenance",
          option === "--candidate-provenance" ? value : "openwrangler.vsix.provenance.json"
        ]),
      /must use different paths/u
    );
  }
  assert.throws(
    () =>
      parseInstalledPerformanceArguments([
        "--pinned-editors",
        "--candidate-in",
        "openwrangler.vsix",
        "--candidate-checksum",
        "openwrangler.vsix.sha256",
        "--candidate-provenance",
        "openwrangler.vsix.provenance.json",
        "--out",
        "openwrangler.vsix.provenance.json"
      ]),
    /must use different paths/u
  );
});

test("installed performance rejects direct and filesystem aliases between reports and candidate artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-alias-"));
  try {
    const candidate = join(directory, "openwrangler.vsix");
    const report = join(directory, "report.json");
    await writeFile(candidate, "candidate");
    assert.throws(
      () =>
        assertInstalledPerformanceArtifactPathSeparation({
          output: candidate,
          candidateInput: candidate
        }),
      /report path aliases a protected candidate artifact/u
    );

    const realParent = join(directory, "real");
    const linkedParent = join(directory, "linked");
    await mkdir(realParent);
    await symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () =>
        assertInstalledPerformanceArtifactPathSeparation({
          output: join(linkedParent, "future.json"),
          candidateInput: join(realParent, "future.json")
        }),
      /report path aliases a protected candidate artifact/u
    );

    const outputSymlink = join(directory, "report-link.json");
    await symlink(candidate, outputSymlink, "file");
    assert.throws(
      () =>
        assertInstalledPerformanceArtifactPathSeparation({
          output: outputSymlink,
          candidateInput: candidate
        }),
      /report path aliases a protected candidate artifact/u
    );

    const hardLinkedReport = join(directory, "hard-report.json");
    await link(candidate, hardLinkedReport);
    assert.throws(
      () =>
        assertInstalledPerformanceArtifactPathSeparation({
          output: hardLinkedReport,
          candidateInput: candidate
        }),
      /report path aliases a protected candidate artifact/u
    );
    assert.doesNotThrow(() =>
      assertInstalledPerformanceArtifactPathSeparation({
        output: report,
        candidateInput: candidate
      })
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("package source guard rejects packageable untracked files, including ignored generated-root extras", async () => {
  const runtimeFile = "python/openwrangler_runtime/user_file.py";
  const scratchFile = "scratch.txt";
  const tracked = ["package.json", "python/openwrangler_runtime/server.py"];

  await assert.rejects(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json", runtimeFile],
      deriveGeneratedFiles: () => new Set()
    }),
    /refuses to package an untracked or unexpected generated source file/u
  );
  await assert.rejects(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json", "media/webview.js", "media/rogue.js"],
      deriveGeneratedFiles: () => new Set(["media/webview.js"]),
      pinGeneratedFile: (path) => packageSourceReceipt([path], [{ path }]).generatedFiles[0]
    }),
    /refuses to package an untracked or unexpected generated source file/u
  );
  await assert.doesNotReject(
    assertNoPackageableUntrackedFiles({
      readTrackedFiles: () => [...tracked],
      listPackageFiles: async () => ["package.json"],
      pinTrackedFile: (path) => packageSourceReceipt([path]).trackedFiles[0],
      pinGeneratedFile: assert.fail,
      deriveGeneratedFiles: () => new Set()
    })
  );
  assert.deepEqual(tracked, ["package.json", "python/openwrangler_runtime/server.py"]);
  assert.equal(scratchFile, "scratch.txt");
});

test("package source guard pins every exact tracked and generated input", async () => {
  const source = await assertNoPackageableUntrackedFiles({
    readTrackedFiles: () => ["package.json"],
    listPackageFiles: async () => ["media/webview.js", "package.json"],
    deriveGeneratedFiles: () => new Set(["media/webview.js"]),
    pinTrackedFile: (path) => packageSourceReceipt([path]).trackedFiles[0],
    pinGeneratedFile: (path) => packageSourceReceipt([path], [{ path }]).generatedFiles[0]
  });
  assert.deepEqual(source, packageSourceReceipt(["media/webview.js", "package.json"], [{ path: "media/webview.js" }]));
});

test("pinned package inventory rejects a source file that appears only while createVSIX runs", () => {
  const pinnedBeforePackaging = ["package.json", "README.md", "LICENSE", "python/openwrangler_runtime/server.py"];
  const packageSource = packageSourceReceipt(pinnedBeforePackaging);
  const transientRuntimeFile = "extension/python/openwrangler_runtime/user_file.py";
  const archiveCreatedDuringPackaging = [
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/package.json",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/python/openwrangler_runtime/server.py",
    transientRuntimeFile
  ];

  assert.throws(
    () => assertInstalledPerformancePackageInventory(packageSource, archiveCreatedDuringPackaging),
    /inventory drifted from its pinned pre-package source set/u
  );
  archiveCreatedDuringPackaging.pop();
  assert.doesNotThrow(() =>
    assertInstalledPerformancePackageInventory(
      packageSource,
      archiveCreatedDuringPackaging,
      archiveDigestsForPackageSource(packageSource)
    )
  );
});

test("pinned package sources reject tracked or generated source changes and archive-byte substitutions", () => {
  const before = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "a".repeat(64) }]
  );
  const changed = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "b".repeat(64), identity: { ...fakeFileIdentity, ino: 9n } }]
  );
  assert.throws(
    () => assertSameInstalledPerformancePackageSources(before, changed),
    /generated package output changed/u
  );
  const changedTracked = packageSourceReceipt(
    ["package.json", "media/webview.js"],
    [{ path: "media/webview.js", sha256: "a".repeat(64) }],
    [{ path: "package.json", sha256: "b".repeat(64), identity: { ...fakeFileIdentity, ino: 8n } }]
  );
  assert.throws(
    () => assertSameInstalledPerformancePackageSources(before, changedTracked),
    /tracked package source changed/u
  );
  assert.throws(
    () =>
      assertInstalledPerformancePackageInventory(
        before,
        ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
        [
          ["extension/package.json", "a".repeat(64)],
          ["extension/media/webview.js", "b".repeat(64)]
        ]
      ),
    /source bytes drifted from their pinned package inputs/u
  );
  assert.throws(
    () =>
      assertInstalledPerformancePackageInventory(
        before,
        ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
        [
          ["extension/package.json", "c".repeat(64)],
          ["extension/media/webview.js", "a".repeat(64)]
        ]
      ),
    /source bytes drifted from their pinned package inputs/u
  );
  assert.doesNotThrow(() =>
    assertInstalledPerformancePackageInventory(
      before,
      ["[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/media/webview.js"],
      [
        ["extension/package.json", "a".repeat(64)],
        ["extension/media/webview.js", "a".repeat(64)]
      ]
    )
  );
});

test("guarded packaging rejects the sealed candidate before verification when createVSIX adds a transient file", async () => {
  const pinned = ["package.json", "python/openwrangler_runtime/server.py"];
  let candidateVerified = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      assertPackageSource: () => packageSourceReceipt(pinned),
      packageCandidate: () => {},
      snapshotCandidate: (_source, destination) => ({
        path: destination,
        sha256: "b".repeat(64),
        bytes: 123,
        fileIdentity: fakeFileIdentity
      }),
      verifyPackageInventory(_receipt, packageSource) {
        assertInstalledPerformancePackageInventory(packageSource, [
          "[Content_Types].xml",
          "extension.vsixmanifest",
          "extension/package.json",
          "extension/python/openwrangler_runtime/server.py",
          "extension/python/openwrangler_runtime/transient.py"
        ]);
      },
      verifyCandidate() {
        candidateVerified = true;
      }
    }),
    /inventory drifted from its pinned pre-package source set/u
  );
  assert.equal(candidateVerified, false);
});

test("guarded candidate packaging checks packageable untracked files immediately around packaging", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  const events = [];
  await packageInstalledPerformanceCandidate({
    destination: "/private/candidate.vsix",
    snapshotDestination: "/private/snapshot.vsix",
    readSource: () => clean,
    readSourceManifest: () => previewSourceManifest(),
    build: () => {},
    assertPackageSource() {
      events.push("package-source");
      return packageSourceReceipt(["package.json"]);
    },
    packageCandidate() {
      events.push("package");
    },
    snapshotCandidate: (_source, destination) => ({
      path: destination,
      sha256: "b".repeat(64),
      bytes: 123,
      fileIdentity: fakeFileIdentity
    }),
    verifyPackageInventory(_receipt, packageSource) {
      assert.deepEqual(packageSource, packageSourceReceipt(["package.json"]));
      events.push("inventory");
    },
    verifyCandidate: () => {}
  });
  assert.deepEqual(events, ["package-source", "package", "package-source", "inventory"]);

  let packaged = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => clean,
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      assertPackageSource() {
        throw new Error("packageable untracked source");
      },
      packageCandidate() {
        packaged = true;
      }
    }),
    /packageable untracked source/u
  );
  assert.equal(packaged, false);
});

test("guarded candidate packaging pins one clean source through build, package, and verification", async () => {
  const commit = "a".repeat(40);
  const clean = { commit, trackedWorktreeDirty: false };
  const events = [];

  const receipt = await packageInstalledPerformanceCandidate({
    destination: "/private/candidate.vsix",
    snapshotDestination: "/private/snapshot.vsix",
    environment: {},
    readSource() {
      events.push("source");
      return clean;
    },
    readSourceManifest() {
      events.push("manifest");
      return previewSourceManifest();
    },
    async build() {
      events.push("build");
    },
    async packageCandidate(destination, options) {
      events.push(["package", destination, options]);
    },
    snapshotCandidate(source, destination) {
      events.push(["snapshot", source, destination]);
      return { path: destination, sha256: "b".repeat(64), bytes: 123, fileIdentity: fakeFileIdentity };
    },
    async verifyCandidate(receipt) {
      events.push(["verify", receipt.path]);
    }
  });

  assert.deepEqual(receipt, {
    path: "/private/snapshot.vsix",
    sha256: "b".repeat(64),
    bytes: 123,
    fileIdentity: fakeFileIdentity,
    source: clean,
    sourceManifest: {
      publisher: "Matt17BR",
      name: "openwrangler",
      version: "0.3.0",
      preview: true,
      channel: "preview"
    },
    buildMethod: "guarded-clean-head-v1"
  });
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.source), true);
  assert.equal(Object.isFrozen(receipt.sourceManifest), true);
  assert.deepEqual(events, [
    "source",
    "manifest",
    "build",
    "source",
    ["package", "/private/candidate.vsix", { preRelease: true }],
    "source",
    ["snapshot", "/private/candidate.vsix", "/private/snapshot.vsix"],
    "source",
    ["verify", "/private/snapshot.vsix"],
    "source"
  ]);
});

test("guarded verification receives the sealed snapshot before mutable build-output drift", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-seal-"));
  try {
    const destination = join(directory, "built.vsix");
    const snapshotDestination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained-built.vsix");
    const original = Buffer.from("candidate bytes verified from the immutable snapshot");
    const replacement = Buffer.from("replacement build output");

    const receipt = await packageInstalledPerformanceCandidate({
      destination,
      snapshotDestination,
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      packageCandidate(path) {
        writeFileSync(path, original, { flag: "wx", mode: 0o600 });
      },
      verifyCandidate(snapshot) {
        assert.equal(snapshot.path, snapshotDestination);
        renameSync(destination, retained);
        writeFileSync(destination, replacement, { flag: "wx", mode: 0o600 });
        assert.deepEqual(readFileSync(snapshot.path), original);
        revalidateInstalledPerformanceVsix(snapshot);
      }
    });

    assert.equal(receipt.path, snapshotDestination);
    assert.deepEqual(await readFile(receipt.path), original);
    assert.deepEqual(await readFile(destination), replacement);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guarded verification rejects an in-place mutation of the sealed snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-seal-"));
  try {
    const destination = join(directory, "built.vsix");
    const snapshotDestination = join(directory, "private", "candidate.vsix");
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination,
        snapshotDestination,
        readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
        readSourceManifest: () => previewSourceManifest(),
        build: () => {},
        packageCandidate(path) {
          writeFileSync(path, "sealed candidate bytes", { flag: "wx", mode: 0o600 });
        },
        verifyCandidate(snapshot) {
          writeFileSync(snapshot.path, "mutated candidate bytes");
          revalidateInstalledPerformanceVsix(snapshot);
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("guarded candidate packaging rejects dirty or drifting checkout provenance", async () => {
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: true }),
      readSourceManifest: () => previewSourceManifest(),
      build: () => assert.fail("a dirty checkout must fail before build"),
      packageCandidate: () => assert.fail("a dirty checkout must fail before package"),
      verifyCandidate: () => assert.fail("a dirty checkout must fail before verification")
    }),
    /clean exact HEAD before candidate build/u
  );

  const sources = [
    { commit: "a".repeat(40), trackedWorktreeDirty: false },
    { commit: "b".repeat(40), trackedWorktreeDirty: false }
  ];
  let packaged = false;
  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/candidate.vsix",
      snapshotDestination: "/private/snapshot.vsix",
      readSource: () => sources.shift(),
      readSourceManifest: () => previewSourceManifest(),
      build: () => {},
      packageCandidate: () => {
        packaged = true;
      },
      verifyCandidate: () => assert.fail("source drift must fail before verification")
    }),
    /source commit changed during candidate build/u
  );
  assert.equal(packaged, false);

  for (const [dirtyRead, expectedStage, expectedVerified] of [
    [2, "during candidate build", false],
    [3, "during candidate packaging", false],
    [4, "during candidate snapshot", false],
    [5, "during candidate verification", true]
  ]) {
    let reads = 0;
    let verified = false;
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource() {
          reads += 1;
          return {
            commit: "a".repeat(40),
            trackedWorktreeDirty: reads === dirtyRead
          };
        },
        readSourceManifest: () => previewSourceManifest(),
        build: () => {},
        packageCandidate: () => {},
        verifyCandidate: () => {
          verified = true;
        },
        snapshotCandidate: () => ({
          path: "/private/snapshot.vsix",
          sha256: "b".repeat(64),
          bytes: 123,
          fileIdentity: fakeFileIdentity
        })
      }),
      new RegExp(`clean exact HEAD ${expectedStage}`, "u")
    );
    assert.equal(verified, expectedVerified);
  }
});

test("guarded candidate packaging never advances after a failed build, package, or verification", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  for (const failedStage of ["build", "package", "verify"]) {
    const events = [];
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource: () => clean,
        readSourceManifest: () => previewSourceManifest(),
        build() {
          events.push("build");
          if (failedStage === "build") throw new Error("build failed");
        },
        packageCandidate() {
          events.push("package");
          if (failedStage === "package") throw new Error("package failed");
        },
        verifyCandidate() {
          events.push("verify");
          if (failedStage === "verify") throw new Error("verify failed");
        },
        snapshotCandidate: () => ({
          path: "/private/snapshot.vsix",
          sha256: "b".repeat(64),
          bytes: 123,
          fileIdentity: fakeFileIdentity
        })
      }),
      new RegExp(`${failedStage} failed`, "u")
    );
    assert.deepEqual(
      events,
      failedStage === "build"
        ? ["build"]
        : failedStage === "package"
          ? ["build", "package"]
          : ["build", "package", "verify"]
    );
  }
});

test("guarded self-packaging is preview-only and stable evidence must use canonical intake", async () => {
  const clean = { commit: "a".repeat(40), trackedWorktreeDirty: false };
  let packageOptions;
  const receipt = await packageInstalledPerformanceCandidate({
    destination: "/private/preview.vsix",
    snapshotDestination: "/private/preview-snapshot.vsix",
    readSource: () => clean,
    readSourceManifest: () => previewSourceManifest(),
    build: () => {},
    packageCandidate(_destination, options) {
      packageOptions = options;
    },
    verifyCandidate: () => {},
    snapshotCandidate: (_source, destination) => ({
      path: destination,
      sha256: "b".repeat(64),
      bytes: 123,
      fileIdentity: fakeFileIdentity
    })
  });

  assert.deepEqual(packageOptions, { preRelease: true });
  assert.equal(receipt.buildMethod, "guarded-clean-head-v1");
  assert.deepEqual(receipt.sourceManifest, {
    publisher: "Matt17BR",
    name: "openwrangler",
    version: "0.3.0",
    preview: true,
    channel: "preview"
  });

  await assert.rejects(
    packageInstalledPerformanceCandidate({
      destination: "/private/stable.vsix",
      snapshotDestination: "/private/stable-snapshot.vsix",
      readSource: () => clean,
      readSourceManifest: () => previewSourceManifest({ version: "1.0.0", preview: false }),
      build: () => assert.fail("stable self-packaging must fail before build"),
      packageCandidate: () => assert.fail("stable self-packaging must fail before package"),
      verifyCandidate: () => assert.fail("stable self-packaging must fail before verification")
    }),
    /must consume the canonical release artifact/u
  );
});

test("source manifest validation rejects ambiguous identity, version, and release channels before build", async () => {
  const invalid = [
    [null, /object-valued source package manifest/u],
    [previewSourceManifest({ publisher: "someone-else" }), /canonical Matt17BR\.openwrangler/u],
    [previewSourceManifest({ name: "another-extension" }), /canonical Matt17BR\.openwrangler/u],
    [previewSourceManifest({ version: "1.0.0-alpha.1" }), /numeric major\.minor\.patch/u],
    [previewSourceManifest({ preview: "true" }), /explicit boolean package preview flag/u],
    [previewSourceManifest({ version: "0.9.0", preview: false }), /Preview-channel version 0\.9\.0/u],
    [previewSourceManifest({ version: "1.0.0", preview: true }), /stable channel/u],
    [previewSourceManifest({ version: "0.2.0", preview: false }), /1\.0\.0 or newer/u]
  ];
  for (const [manifest, expectedError] of invalid) {
    assert.throws(() => validateInstalledPerformanceSourceManifest(manifest), expectedError);
    await assert.rejects(
      packageInstalledPerformanceCandidate({
        destination: "/private/candidate.vsix",
        snapshotDestination: "/private/snapshot.vsix",
        readSource: () => ({ commit: "a".repeat(40), trackedWorktreeDirty: false }),
        readSourceManifest: () => manifest,
        build: () => assert.fail("an invalid source manifest must fail before build")
      }),
      expectedError
    );
  }
});

test("source manifest reading returns only canonical release-channel provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-manifest-"));
  try {
    const manifestPath = join(directory, "package.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        ...previewSourceManifest({ version: "1.0.0", preview: false }),
        displayName: "Open Wrangler",
        scripts: { build: "ignored" }
      })
    );

    assert.deepEqual(readInstalledPerformanceSourceManifest(manifestPath), {
      publisher: "Matt17BR",
      name: "openwrangler",
      version: "1.0.0",
      preview: false,
      channel: "stable"
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical candidate intake pins one exact VSIX and checksum pair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-canonical-"));
  try {
    const candidatePath = join(directory, "openwrangler.vsix");
    const checksumPath = join(directory, "openwrangler.vsix.sha256");
    const candidateBytes = Buffer.from("canonical release candidate");
    const candidateSha256 = createHash("sha256").update(candidateBytes).digest("hex");
    await writeFile(candidatePath, candidateBytes);
    await writeFile(checksumPath, `${candidateSha256}  openwrangler.vsix\n`);

    const candidateReceipt = readInstalledPerformanceVsixReceipt(candidatePath);
    const checksumReceipt = readInstalledPerformanceChecksum(checksumPath, candidatePath);

    assert.equal(candidateReceipt.sha256, candidateSha256);
    assert.equal(candidateReceipt.bytes, candidateBytes.length);
    assert.equal(checksumReceipt.candidatePath, candidatePath);
    assert.equal(checksumReceipt.candidateSha256, candidateSha256);
    assert.equal(Object.isFrozen(candidateReceipt), true);
    assert.equal(Object.isFrozen(checksumReceipt), true);
    assert.equal(revalidateInstalledPerformanceVsix(candidateReceipt), candidateReceipt);
    assert.equal(revalidateInstalledPerformanceChecksum(checksumReceipt, candidatePath), checksumReceipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical checksum intake rejects malformed, linked, and changing receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-checksum-"));
  try {
    const candidatePath = join(directory, "openwrangler.vsix");
    const checksumPath = join(directory, "openwrangler.vsix.sha256");
    const digest = "a".repeat(64);
    await writeFile(candidatePath, "candidate");

    for (const malformed of [
      `${digest.toUpperCase()}  openwrangler.vsix\n`,
      `${digest} *openwrangler.vsix\n`,
      `${digest} openwrangler.vsix\n`,
      `${digest}  another.vsix\n`,
      `${digest}  openwrangler.vsix`,
      `${digest}  openwrangler.vsix\nextra\n`,
      "x".repeat(513)
    ]) {
      await writeFile(checksumPath, malformed);
      assert.throws(
        () => readInstalledPerformanceChecksum(checksumPath, candidatePath),
        /bounded current-user-owned|exactly one lowercase SHA-256 line/u
      );
    }

    await writeFile(checksumPath, `${digest}  openwrangler.vsix\n`);
    const hardLink = join(directory, "checksum-hardlink");
    await link(checksumPath, hardLink);
    assert.throws(
      () => readInstalledPerformanceChecksum(checksumPath, candidatePath),
      /single-link regular file|bounded current-user-owned|changed before it was read/u
    );
    await rm(hardLink);

    const symlinkPath = join(directory, "checksum-symlink");
    await symlink(checksumPath, symlinkPath);
    assert.throws(
      () => readInstalledPerformanceChecksum(symlinkPath, candidatePath),
      /single-link regular file|changed before it was read/u
    );
    assert.throws(
      () => readInstalledPerformanceChecksum(checksumPath, join(directory, "candidate.vsix")),
      /candidate filename openwrangler\.vsix/u
    );

    await writeFile(checksumPath, `${digest}  openwrangler.vsix\n`);
    assert.throws(
      () =>
        readInstalledPerformanceChecksum(checksumPath, candidatePath, {
          afterOpen() {
            writeFileSync(checksumPath, `${"b".repeat(64)}  openwrangler.vsix\nx`);
          }
        }),
      /changed while it was read|path changed while it was read/u
    );

    await writeFile(checksumPath, `${digest}  openwrangler.vsix\n`);
    const retained = join(directory, "checksum-retained");
    assert.throws(
      () =>
        readInstalledPerformanceChecksum(checksumPath, candidatePath, {
          afterRead() {
            renameSync(checksumPath, retained);
            writeFileSync(checksumPath, `${digest}  openwrangler.vsix\n`, {
              flag: "wx",
              mode: 0o600
            });
          }
        }),
      /changed while it was read|path changed while it was read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical provenance intake pins one strict stable build receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-provenance-"));
  try {
    const provenancePath = join(directory, "openwrangler.vsix.provenance.json");
    const value = {
      protocol: "openwrangler-canonical-release-artifact-v1",
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "1.0.0",
      preview: false,
      releaseTag: "v1.0.0",
      sourceCommit: "a".repeat(40),
      vsixSha256: "b".repeat(64),
      vsixBytes: 123
    };
    await writeFile(provenancePath, `${JSON.stringify(value)}\n`);

    const receipt = readInstalledPerformanceProvenance(provenancePath);
    assert.deepEqual(
      {
        protocol: receipt.protocol,
        extensionId: receipt.extensionId,
        extensionVersion: receipt.extensionVersion,
        preview: receipt.preview,
        releaseTag: receipt.releaseTag,
        sourceCommit: receipt.sourceCommit,
        vsixSha256: receipt.vsixSha256,
        vsixBytes: receipt.vsixBytes
      },
      value
    );
    assert.equal(Object.isFrozen(receipt), true);
    assert.equal(revalidateInstalledPerformanceProvenance(receipt), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ordinary stable provenance consumers reject the evidence-only artifact role", async () => {
  const evidenceOnly = {
    protocol: PERFORMANCE_EVIDENCE_ARTIFACT_PROTOCOL,
    artifactRole: PERFORMANCE_EVIDENCE_ARTIFACT_ROLE,
    extensionId: "Matt17BR.openwrangler",
    extensionVersion: "1.0.0",
    preview: false,
    releaseTag: "v1.0.0",
    sourceCommit: "a".repeat(40),
    vsixSha256: "b".repeat(64),
    vsixBytes: 123
  };
  assert.deepEqual(validatePerformanceEvidenceProvenance(evidenceOnly), evidenceOnly);
  assert.throws(() => validateInstalledPerformanceProvenance(evidenceOnly), /exactly the canonical artifact fields/u);

  const stable = { ...evidenceOnly };
  delete stable.artifactRole;
  stable.protocol = "openwrangler-canonical-release-artifact-v1";
  assert.deepEqual(validateInstalledPerformanceProvenance(stable), stable);
  assert.throws(() => validatePerformanceEvidenceProvenance(stable), /exactly its evidence-only artifact fields/u);

  const directory = await mkdtemp(join(tmpdir(), "ow-installed-evidence-provenance-"));
  try {
    const provenancePath = join(directory, "openwrangler.vsix.provenance.json");
    await writeFile(provenancePath, `${JSON.stringify(evidenceOnly)}\n`);
    assert.throws(() => readInstalledPerformanceProvenance(provenancePath), /exactly the canonical artifact fields/u);
    const receipt = readPerformanceEvidenceProvenance(provenancePath);
    assert.equal(receipt.artifactRole, PERFORMANCE_EVIDENCE_ARTIFACT_ROLE);
    assert.equal(revalidatePerformanceEvidenceProvenance(receipt), receipt);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical provenance intake rejects malformed, linked, and changing receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-provenance-invalid-"));
  try {
    const provenancePath = join(directory, "openwrangler.vsix.provenance.json");
    const value = {
      protocol: "openwrangler-canonical-release-artifact-v1",
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "1.0.0",
      preview: false,
      releaseTag: "v1.0.0",
      sourceCommit: "a".repeat(40),
      vsixSha256: "b".repeat(64),
      vsixBytes: 123
    };
    for (const malformed of [
      "{",
      JSON.stringify({ ...value, unexpected: true }),
      JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "releaseTag"))),
      JSON.stringify({ ...value, preview: true }),
      JSON.stringify({ ...value, extensionVersion: "0.2.0", releaseTag: "v0.2.0" }),
      JSON.stringify({ ...value, sourceCommit: "A".repeat(40) }),
      JSON.stringify({ ...value, vsixSha256: "B".repeat(64) }),
      JSON.stringify({ ...value, vsixBytes: 0 })
    ]) {
      await writeFile(provenancePath, malformed);
      assert.throws(
        () => readInstalledPerformanceProvenance(provenancePath),
        /Unterminated JSON|strict JSON|canonical artifact fields|canonical stable artifact/u
      );
    }

    await writeFile(provenancePath, JSON.stringify(value));
    const hardLink = join(directory, "provenance-hardlink.json");
    await link(provenancePath, hardLink);
    assert.throws(
      () => readInstalledPerformanceProvenance(provenancePath),
      /single-link regular file|bounded current-user-owned|changed before it was read/u
    );
    await rm(hardLink);

    const symlinkDirectory = join(directory, "symlink");
    await mkdir(symlinkDirectory);
    const symlinkPath = join(symlinkDirectory, "openwrangler.vsix.provenance.json");
    await symlink(provenancePath, symlinkPath);
    assert.throws(
      () => readInstalledPerformanceProvenance(symlinkPath),
      /single-link regular file|changed before it was read/u
    );
    await rm(symlinkDirectory, { recursive: true, force: true });

    assert.throws(
      () =>
        readInstalledPerformanceProvenance(provenancePath, {
          afterOpen() {
            writeFileSync(provenancePath, `${JSON.stringify({ ...value, vsixBytes: 124 })}\n`);
          }
        }),
      /changed while it was read|path changed while it was read/u
    );

    await writeFile(provenancePath, JSON.stringify(value));
    const receipt = readInstalledPerformanceProvenance(provenancePath);
    await writeFile(provenancePath, `${JSON.stringify({ ...value, vsixBytes: 124 })}\n`);
    assert.throws(() => revalidateInstalledPerformanceProvenance(receipt), /changed|receipt/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical candidate acceptance binds stable source, checksum, and canonical provenance", async () => {
  const commit = "a".repeat(40);
  const candidatePath = resolve("release", "openwrangler.vsix");
  const checksumPath = resolve("release", "openwrangler.vsix.sha256");
  const provenancePath = resolve("release", "openwrangler.vsix.provenance.json");
  const privatePath = resolve("private", "candidate.vsix");
  const external = fakeVsixReceipt(candidatePath);
  const staged = fakeVsixReceipt(privatePath);
  const checksum = Object.freeze({
    path: checksumPath,
    candidatePath,
    candidateSha256: external.sha256,
    sha256: "c".repeat(64),
    bytes: 86,
    fileIdentity: Object.freeze({ ...fakeFileIdentity, size: 86n })
  });
  const provenance = fakeProvenanceReceipt(provenancePath, {
    sourceCommit: commit,
    vsixSha256: external.sha256,
    vsixBytes: external.bytes
  });
  const events = [];

  const accepted = await acceptInstalledPerformanceCandidate({
    candidatePath,
    checksumPath,
    provenancePath,
    privateDestination: privatePath,
    expectedCommit: commit,
    releaseTag: "v1.0.0",
    readSource: () => ({ commit, trackedWorktreeDirty: false }),
    readSourceManifest: () => previewSourceManifest({ version: "1.0.0", preview: false }),
    readExternalCandidate(path) {
      assert.equal(path, candidatePath);
      return external;
    },
    readChecksum(path, candidate) {
      assert.equal(path, checksumPath);
      assert.equal(candidate, candidatePath);
      return checksum;
    },
    readProvenance(path) {
      assert.equal(path, provenancePath);
      return provenance;
    },
    readReleaseTagCommit(tag) {
      assert.equal(tag, "v1.0.0");
      events.push("tag");
      return commit;
    },
    stageCandidate(source, destination) {
      assert.equal(source, candidatePath);
      assert.equal(destination, privatePath);
      events.push("stage");
      return staged;
    },
    verifyCandidate(receipt) {
      assert.equal(receipt.path, privatePath);
      events.push("verify");
    },
    readCandidate(receipt) {
      assert.equal(receipt.buildMethod, "canonical-release-artifact-v1");
      assert.equal(receipt.sourceManifest.channel, "stable");
      assert.equal(receipt.releaseTag, "v1.0.0");
      assert.equal(receipt.provenanceSha256, provenance.sha256);
      events.push("metadata");
      return Object.freeze({
        extensionId: "Matt17BR.openwrangler",
        extensionVersion: "1.0.0",
        preview: false,
        channel: "stable",
        buildMethod: receipt.buildMethod,
        releaseTag: receipt.releaseTag,
        provenanceSha256: receipt.provenanceSha256,
        sourceCommit: commit,
        vsixSha256: receipt.sha256,
        vsixBytes: receipt.bytes
      });
    },
    revalidateCandidate(receipt) {
      assert.ok(receipt.path === candidatePath || receipt.path === privatePath);
      events.push(`candidate:${receipt.path}`);
    },
    revalidateChecksum(receipt, candidate) {
      assert.equal(receipt, checksum);
      assert.equal(candidate, candidatePath);
      events.push("checksum");
    },
    revalidateProvenance(receipt) {
      assert.equal(receipt, provenance);
      events.push("provenance");
    }
  });

  assert.equal(accepted.candidate.buildMethod, "canonical-release-artifact-v1");
  assert.equal(accepted.candidate.releaseTag, "v1.0.0");
  assert.equal(accepted.candidate.provenanceSha256, provenance.sha256);
  assert.equal(accepted.candidateReceipt.buildMethod, "canonical-release-artifact-v1");
  assert.equal(accepted.candidateReceipt.releaseTag, "v1.0.0");
  assert.equal(accepted.candidateReceipt.provenanceSha256, provenance.sha256);
  assert.equal(accepted.publicCandidateReceipt, external);
  assert.equal(accepted.publicChecksumReceipt, checksum);
  assert.equal(accepted.publicProvenanceReceipt, provenance);
  assert.deepEqual(
    events.filter((event) => ["tag", "stage", "verify", "metadata"].includes(event)),
    ["tag", "stage", "verify", "metadata"]
  );
  assert.ok(events.filter((event) => event === "checksum").length >= 3);
  assert.ok(events.filter((event) => event === "provenance").length >= 3);
});

test("performance-evidence intake stays distinct from an ordinary stable artifact", async () => {
  const commit = "a".repeat(40);
  const candidatePath = resolve("release", "openwrangler.vsix");
  const checksumPath = resolve("release", "openwrangler.vsix.sha256");
  const provenancePath = resolve("release", "openwrangler.vsix.provenance.json");
  const privatePath = resolve("private", "candidate.vsix");
  const external = fakeVsixReceipt(candidatePath);
  const staged = fakeVsixReceipt(privatePath);
  const checksum = Object.freeze({
    path: checksumPath,
    candidatePath,
    candidateSha256: external.sha256,
    sha256: "c".repeat(64),
    bytes: 86,
    fileIdentity: Object.freeze({ ...fakeFileIdentity, size: 86n })
  });
  const evidence = fakeEvidenceProvenanceReceipt(provenancePath, {
    sourceCommit: commit,
    vsixSha256: external.sha256,
    vsixBytes: external.bytes
  });

  const accepted = await acceptInstalledPerformanceCandidate({
    artifactKind: PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
    candidatePath,
    checksumPath,
    provenancePath,
    privateDestination: privatePath,
    expectedCommit: commit,
    releaseTag: "v1.0.0",
    readSource: () => ({ commit, trackedWorktreeDirty: false }),
    readSourceManifest: () => previewSourceManifest({ version: "1.0.0", preview: false }),
    readExternalCandidate: () => external,
    readChecksum: () => checksum,
    readProvenance: () => evidence,
    readReleaseTagCommit: () => commit,
    stageCandidate: () => staged,
    verifyCandidate: () => {},
    readCandidate(receipt) {
      assert.equal(receipt.buildMethod, "performance-evidence-artifact-v1");
      return Object.freeze({
        extensionId: "Matt17BR.openwrangler",
        extensionVersion: "1.0.0",
        preview: false,
        channel: "stable",
        buildMethod: receipt.buildMethod,
        releaseTag: receipt.releaseTag,
        provenanceSha256: receipt.provenanceSha256,
        sourceCommit: commit,
        vsixSha256: receipt.sha256,
        vsixBytes: receipt.bytes
      });
    },
    revalidateCandidate: () => {},
    revalidateChecksum: () => {},
    revalidateProvenance: () => {}
  });
  assert.equal(accepted.candidate.buildMethod, "performance-evidence-artifact-v1");
  assert.equal(accepted.candidateReceipt.buildMethod, "performance-evidence-artifact-v1");

  await assert.rejects(
    acceptInstalledPerformanceCandidate({
      artifactKind: PERFORMANCE_EVIDENCE_ARTIFACT_KIND,
      candidatePath,
      checksumPath,
      provenancePath,
      privateDestination: privatePath,
      expectedCommit: commit,
      releaseTag: "v1.0.0",
      readSource: () => ({ commit, trackedWorktreeDirty: false }),
      readSourceManifest: () => previewSourceManifest({ version: "1.0.0", preview: false }),
      readExternalCandidate: () => external,
      readChecksum: () => checksum,
      readProvenance: () => fakeProvenanceReceipt(provenancePath),
      readReleaseTagCommit: () => commit,
      stageCandidate: () => assert.fail("mismatched provenance must fail before staging"),
      revalidateCandidate: () => {},
      revalidateChecksum: () => {},
      revalidateProvenance: () => {}
    }),
    /requested publication kind/u
  );
});

test("canonical candidate acceptance rejects invalid release provenance and digest before staging", async () => {
  const commit = "a".repeat(40);
  const candidatePath = resolve("release", "openwrangler.vsix");
  const checksumPath = resolve("release", "openwrangler.vsix.sha256");
  const provenancePath = resolve("release", "openwrangler.vsix.provenance.json");
  const external = fakeVsixReceipt(candidatePath);
  const provenance = fakeProvenanceReceipt(provenancePath, {
    sourceCommit: commit,
    vsixSha256: external.sha256,
    vsixBytes: external.bytes
  });
  const base = {
    candidatePath,
    checksumPath,
    provenancePath,
    privateDestination: resolve("private", "candidate.vsix"),
    expectedCommit: commit,
    releaseTag: "v1.0.0",
    readSource: () => ({ commit, trackedWorktreeDirty: false }),
    readSourceManifest: () => previewSourceManifest({ version: "1.0.0", preview: false }),
    readReleaseTagCommit: () => commit,
    readExternalCandidate: () => external,
    readChecksum: () => ({ candidateSha256: external.sha256 }),
    readProvenance: () => provenance,
    stageCandidate: () => assert.fail("rejected canonical intake must not stage a candidate"),
    verifyCandidate: () => assert.fail("rejected canonical intake must not verify a candidate")
  };

  await assert.rejects(
    acceptInstalledPerformanceCandidate({
      ...base,
      readChecksum: () => ({ candidateSha256: "0".repeat(64) })
    }),
    /does not match its transferred checksum/u
  );
  await assert.rejects(
    acceptInstalledPerformanceCandidate({
      ...base,
      checksumPath: candidatePath
    }),
    /paths must be different/u
  );
  for (const [overrides, expected] of [
    [{ expectedCommit: "A".repeat(40) }, /EXPECTED_SHA/u],
    [{ releaseTag: "1.0.0" }, /RELEASE_TAG/u],
    [{ readSourceManifest: () => previewSourceManifest() }, /requires stable package metadata/u],
    [
      { readSourceManifest: () => previewSourceManifest({ version: "1.1.0", preview: false }) },
      /exactly match the stable source package version/u
    ]
  ]) {
    await assert.rejects(
      acceptInstalledPerformanceCandidate({
        ...base,
        ...overrides,
        readExternalCandidate: () => assert.fail("invalid release provenance must fail before candidate input")
      }),
      expected
    );
  }

  let artifactReads = 0;
  await assert.rejects(
    acceptInstalledPerformanceCandidate({
      ...base,
      readReleaseTagCommit: () => "f".repeat(40),
      readExternalCandidate: () => {
        artifactReads += 1;
        return external;
      }
    }),
    /resolve to the exact expected source commit/u
  );
  assert.equal(artifactReads, 0);

  for (const overrides of [{ vsixSha256: "0".repeat(64) }, { vsixBytes: external.bytes + 1 }]) {
    let stageCalls = 0;
    await assert.rejects(
      acceptInstalledPerformanceCandidate({
        ...base,
        readProvenance: () => fakeProvenanceReceipt(provenancePath, overrides),
        stageCandidate: () => {
          stageCalls += 1;
          return fakeVsixReceipt(resolve("private", "candidate.vsix"));
        }
      }),
      /does not match its trusted build provenance/u
    );
    assert.equal(stageCalls, 0);
  }
});

test("consume-only preparation builds only the acceptance harness and retains all canonical artifact receipts", async () => {
  const commit = "a".repeat(40);
  const candidatePath = resolve("release", "openwrangler.vsix");
  const checksumPath = resolve("release", "openwrangler.vsix.sha256");
  const provenancePath = resolve("release", "openwrangler.vsix.provenance.json");
  const privateRoot = resolve("private");
  const candidateReceipt = fakeVsixReceipt(resolve(privateRoot, "candidate.vsix"));
  const publicCandidateReceipt = fakeVsixReceipt(candidatePath);
  const publicChecksumReceipt = { marker: "checksum" };
  const publicProvenanceReceipt = { marker: "provenance" };
  const accepted = Object.freeze({
    candidate: { buildMethod: "canonical-release-artifact-v1" },
    candidateReceipt,
    publicCandidateReceipt,
    publicChecksumReceipt,
    publicProvenanceReceipt,
    sourceBefore: Object.freeze({ commit, trackedWorktreeDirty: false })
  });
  const events = [];

  const prepared = await prepareInstalledPerformanceCandidate({
    options: {
      mode: "consume",
      smoke: false,
      editors: ["vscode", "cursor"],
      candidateInput: candidatePath,
      candidateChecksum: checksumPath,
      candidateProvenance: provenancePath,
      candidateOutput: undefined
    },
    privateRoot,
    environment: {},
    acceptCandidate: async (options) => {
      assert.equal(options.candidatePath, candidatePath);
      assert.equal(options.checksumPath, checksumPath);
      assert.equal(options.provenancePath, provenancePath);
      events.push("accept");
      return accepted;
    },
    packageCandidate: () => assert.fail("consume-only preparation must never package"),
    readCandidate: () => assert.fail("consume-only preparation must not reread through package mode"),
    stageCandidate: () => assert.fail("consume-only preparation must not publish a second candidate"),
    buildHarness: async () => {
      events.push("harness");
    },
    verifyHarness() {
      events.push("preflight");
    },
    readSource: () => ({ commit, trackedWorktreeDirty: false }),
    revalidateCandidate(receipt) {
      assert.ok(receipt === candidateReceipt || receipt === publicCandidateReceipt);
      events.push("candidate");
    },
    revalidateChecksum(receipt, candidate) {
      assert.equal(receipt, publicChecksumReceipt);
      assert.equal(candidate, publicCandidateReceipt.path);
      events.push("checksum");
    },
    revalidateProvenance(receipt) {
      assert.equal(receipt, publicProvenanceReceipt);
      events.push("provenance");
    }
  });

  assert.equal(prepared, accepted);
  assert.deepEqual(events, ["accept", "harness", "preflight", "candidate", "candidate", "checksum", "provenance"]);
});

test("candidate preparation rejects programmatically inconsistent consume and package modes before work", async () => {
  const noWork = {
    privateRoot: "/private",
    acceptCandidate: () => assert.fail("invalid consume options must fail before intake"),
    packageCandidate: () => assert.fail("invalid package options must fail before packaging")
  };
  for (const options of [
    {
      mode: "consume",
      smoke: true,
      editors: ["vscode", "cursor"],
      candidateInput: resolve("release", "openwrangler.vsix"),
      candidateChecksum: resolve("release", "openwrangler.vsix.sha256"),
      candidateProvenance: resolve("release", "openwrangler.vsix.provenance.json"),
      candidateOutput: undefined
    },
    {
      mode: "consume",
      smoke: false,
      editors: ["vscode"],
      candidateInput: resolve("release", "openwrangler.vsix"),
      candidateChecksum: resolve("release", "openwrangler.vsix.sha256"),
      candidateProvenance: resolve("release", "openwrangler.vsix.provenance.json"),
      candidateOutput: undefined
    },
    {
      mode: "package",
      smoke: false,
      editors: ["vscode", "cursor"],
      candidateInput: resolve("release", "openwrangler.vsix"),
      candidateChecksum: undefined,
      candidateProvenance: undefined,
      candidateOutput: "/tmp/copy.vsix"
    },
    {
      mode: "consume",
      smoke: false,
      editors: ["vscode", "cursor"],
      candidateInput: resolve("release", "openwrangler.vsix"),
      candidateChecksum: resolve("release", "openwrangler.vsix.sha256"),
      candidateProvenance: undefined,
      candidateOutput: undefined
    }
  ]) {
    await assert.rejects(prepareInstalledPerformanceCandidate({ ...noWork, options }), /inconsistent option set/u);
  }
});

test("candidate metadata rejects any receipt not minted by guarded packaging", async () => {
  await assert.rejects(
    readInstalledPerformanceCandidate({
      path: "/tmp/arbitrary.vsix",
      sha256: "b".repeat(64),
      bytes: 123,
      source: { commit: "a".repeat(40), trackedWorktreeDirty: false }
    }),
    /guarded candidate receipt/u
  );
});

test("the VSIX snapshot copies and hashes one pinned regular file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const bytes = Buffer.from("deterministic candidate bytes");
    await writeFile(source, bytes);

    const snapshot = stageInstalledPerformanceVsix(source, destination);

    assert.equal(snapshot.bytes, bytes.length);
    assert.equal(snapshot.sha256, "4fd9b5f5c728de97c6b47a9db2fa77ec840d29766f562b7cff26fe4a0a903391");
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.fileIdentity), true);
    assert.equal(revalidateInstalledPerformanceVsix(snapshot), snapshot);
    assert.deepEqual(await readFile(destination), bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX receipt rejects path substitution after editor installation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "deterministic candidate");
    const receipt = stageInstalledPerformanceVsix(source, destination);

    renameSync(destination, retained);
    writeFileSync(destination, "substituted candidate");

    assert.throws(() => revalidateInstalledPerformanceVsix(receipt), /VSIX (receipt|path) changed/u);
    assert.equal(await readFile(destination, "utf8"), "substituted candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX receipt rejects checksum drift and a same-path swap during its descriptor snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "deterministic candidate");
    const receipt = stageInstalledPerformanceVsix(source, destination);

    assert.throws(
      () => revalidateInstalledPerformanceVsix({ ...receipt, sha256: "0".repeat(64) }),
      /checksum receipt/u
    );

    const originalReadFileSync = readFileSync;
    let swapped = false;
    context.mock.method(fs, "readFileSync", (...arguments_) => {
      if (!swapped && typeof arguments_[0] === "number") {
        swapped = true;
        renameSync(destination, retained);
        writeFileSync(destination, "replacement candidate", { flag: "wx", mode: 0o600 });
      }
      return originalReadFileSync(...arguments_);
    });

    assert.throws(() => revalidateInstalledPerformanceVsix(receipt), /changed while its descriptor snapshot was read/u);
    assert.equal(swapped, true);
    assert.equal(await readFile(destination, "utf8"), "replacement candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation validates the exact receipt at the editor CLI spawn boundary and after exit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);
    const events = [];

    await installInstalledPerformanceCandidate({
      editor: { name: "VS Code", key: "vscode" },
      candidateReceipt: receipt,
      userData: join(directory, "user"),
      extensions: join(directory, "extensions"),
      sandboxArgs: ["--no-sandbox"],
      environment: {},
      revalidateCandidate(exactReceipt) {
        assert.equal(exactReceipt, receipt);
        revalidateInstalledPerformanceVsix(exactReceipt);
        events.push("validate");
      },
      spawnOwned(_executable, arguments_) {
        assert.equal(arguments_.filter((value) => value === receipt.path).length, 1);
        events.push("spawn");
        return { pid: 4812 };
      },
      async runCli(command, options) {
        assert.equal(command.args[command.args.indexOf("--install-extension") + 1], receipt.path);
        options.spawnProcess("/editor-cli", command.args, {});
        events.push("exit");
        return { stdout: "", stderr: "" };
      }
    });

    assert.deepEqual(events, ["validate", "spawn", "exit", "validate"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation rejects pre-spawn path substitution before the editor CLI starts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);
    let spawned = false;

    await assert.rejects(
      installInstalledPerformanceCandidate({
        editor: { name: "VS Code", key: "vscode" },
        candidateReceipt: receipt,
        userData: join(directory, "user"),
        extensions: join(directory, "extensions"),
        sandboxArgs: [],
        environment: {},
        spawnOwned() {
          spawned = true;
          return { pid: 4812 };
        },
        async runCli(command, options) {
          renameSync(candidate, retained);
          writeFileSync(candidate, "substituted candidate", { flag: "wx", mode: 0o600 });
          options.spawnProcess("/editor-cli", command.args, {});
          return { stdout: "", stderr: "" };
        }
      }),
      /VSIX (receipt|path) changed/u
    );
    assert.equal(spawned, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("candidate installation rejects same-inode drift introduced at the spawn boundary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-install-"));
  try {
    const source = join(directory, "source.vsix");
    const candidate = join(directory, "candidate.vsix");
    await writeFile(source, "candidate installed at the exact spawn boundary");
    const receipt = stageInstalledPerformanceVsix(source, candidate);

    await assert.rejects(
      installInstalledPerformanceCandidate({
        editor: { name: "Cursor", key: "cursor" },
        candidateReceipt: receipt,
        userData: join(directory, "user"),
        extensions: join(directory, "extensions"),
        sandboxArgs: [],
        environment: {},
        spawnOwned() {
          writeFileSync(candidate, "candidate mutated after pre-spawn validation");
          return { pid: 4812 };
        },
        async runCli(command, options) {
          options.spawnProcess("/editor-cli", command.args, {});
          return { stdout: "", stderr: "" };
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor collection revalidates the exact VSIX receipt only after both editors finish", async () => {
  const events = [];
  const receipt = { marker: "candidate" };
  const publicReceipt = { marker: "public-candidate" };
  const checksumReceipt = { marker: "checksum" };
  const provenanceReceipt = { marker: "provenance" };
  const runs = await collectInstalledPerformanceEditorRuns({
    editors: [{ key: "vscode" }, { key: "cursor" }],
    candidateReceipt: receipt,
    publicCandidateReceipt: publicReceipt,
    publicChecksumReceipt: checksumReceipt,
    publicProvenanceReceipt: provenanceReceipt,
    async runEditor(editor) {
      events.push(`run:${editor.key}`);
      return { editor: editor.key };
    },
    revalidateCandidate(candidate) {
      assert.ok(candidate === receipt || candidate === publicReceipt);
      events.push(`revalidate:${candidate.marker}`);
    },
    revalidateChecksum(checksum) {
      assert.equal(checksum, checksumReceipt);
      events.push("revalidate:checksum");
    },
    revalidateProvenance(provenance) {
      assert.equal(provenance, provenanceReceipt);
      events.push("revalidate:provenance");
    }
  });

  assert.deepEqual(runs, [{ editor: "vscode" }, { editor: "cursor" }]);
  assert.deepEqual(events, [
    "run:vscode",
    "run:cursor",
    "revalidate:candidate",
    "revalidate:public-candidate",
    "revalidate:checksum",
    "revalidate:provenance"
  ]);
});

test("editor collection rejects public candidate drift after the editor runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-public-"));
  try {
    const source = join(directory, "source.vsix");
    const privateCandidate = join(directory, "private.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes retained through final reporting");
    const privateReceipt = stageInstalledPerformanceVsix(source, privateCandidate);
    const publicReceipt = stageInstalledPerformanceVsix(privateCandidate, publicCandidate);

    await assert.rejects(
      collectInstalledPerformanceEditorRuns({
        editors: [{ key: "vscode" }],
        candidateReceipt: privateReceipt,
        publicCandidateReceipt: publicReceipt,
        async runEditor() {
          writeFileSync(publicCandidate, "public candidate drift before final reporting");
          return { editor: "vscode" };
        }
      }),
      /VSIX (receipt|checksum)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("editor collection rejects canonical provenance drift after the editor runs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-public-provenance-"));
  try {
    const provenancePath = join(directory, "openwrangler.vsix.provenance.json");
    const value = {
      protocol: "openwrangler-canonical-release-artifact-v1",
      extensionId: "Matt17BR.openwrangler",
      extensionVersion: "1.0.0",
      preview: false,
      releaseTag: "v1.0.0",
      sourceCommit: "a".repeat(40),
      vsixSha256: "b".repeat(64),
      vsixBytes: 123
    };
    await writeFile(provenancePath, JSON.stringify(value));
    const provenanceReceipt = readInstalledPerformanceProvenance(provenancePath);

    await assert.rejects(
      collectInstalledPerformanceEditorRuns({
        editors: [{ key: "vscode" }],
        candidateReceipt: { marker: "private" },
        publicProvenanceReceipt: provenanceReceipt,
        revalidateCandidate() {},
        async runEditor() {
          writeFileSync(provenancePath, `${JSON.stringify({ ...value, vsixBytes: 124 })}\n`);
          return { editor: "vscode" };
        }
      }),
      /provenance.*(changed|receipt)/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication refuses an aliased report path before writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-publication-alias-"));
  try {
    const candidate = join(directory, "openwrangler.vsix");
    await writeFile(candidate, "candidate");
    let writeCalls = 0;
    assert.throws(
      () =>
        publishInstalledPerformanceReleaseResult({
          output: candidate,
          result: { protocol: "test" },
          publicCandidateReceipt: { path: candidate },
          writeReport() {
            writeCalls += 1;
            return { marker: "report" };
          }
        }),
      /report path aliases a protected candidate artifact/u
    );
    assert.equal(writeCalls, 0);
    assert.equal(await readFile(candidate, "utf8"), "candidate");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication rejects public candidate drift introduced while the report is written", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-final-"));
  try {
    const source = join(directory, "source.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes before final report publication");
    const publicReceipt = stageInstalledPerformanceVsix(source, publicCandidate);
    let reportRevalidated = false;

    assert.throws(
      () =>
        publishInstalledPerformanceReleaseResult({
          output: join(directory, "report.json"),
          result: { protocol: "test" },
          publicCandidateReceipt: publicReceipt,
          writeReport() {
            writeFileSync(publicCandidate, "candidate drift during final report publication");
            return { marker: "report" };
          },
          assertGate() {},
          revalidateReport() {
            reportRevalidated = true;
          }
        }),
      /VSIX (receipt|checksum)/u
    );
    assert.equal(reportRevalidated, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication rejects candidate mutation while the report is revalidated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-joint-final-"));
  try {
    const source = join(directory, "source.vsix");
    const publicCandidate = join(directory, "public.vsix");
    await writeFile(source, "candidate bytes before joint final validation");
    const publicReceipt = stageInstalledPerformanceVsix(source, publicCandidate);
    let reportReads = 0;

    assert.throws(
      () =>
        publishInstalledPerformanceReleaseResult({
          output: join(directory, "report.json"),
          result: { protocol: "test" },
          publicCandidateReceipt: publicReceipt,
          writeReport: () => ({ marker: "report" }),
          assertGate() {},
          revalidateReport(_receipt, hooks) {
            reportReads += 1;
            writeFileSync(publicCandidate, "candidate mutation while reading the report");
            hooks.afterOpen();
          }
        }),
      /VSIX (receipt|checksum)/u
    );
    assert.equal(reportReads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication jointly revalidates the candidate while the report is pinned and after its read", () => {
  const events = [];
  const candidateReceipt = { marker: "candidate", path: resolve("release", "openwrangler.vsix") };
  const checksumReceipt = {
    marker: "checksum",
    path: resolve("release", "openwrangler.vsix.sha256")
  };
  const provenanceReceipt = {
    marker: "provenance",
    path: resolve("release", "openwrangler.vsix.provenance.json")
  };
  const reportReceipt = { marker: "report" };
  assert.equal(
    publishInstalledPerformanceReleaseResult({
      output: resolve("private", "report.json"),
      result: { protocol: "test" },
      publicCandidateReceipt: candidateReceipt,
      publicChecksumReceipt: checksumReceipt,
      publicProvenanceReceipt: provenanceReceipt,
      writeReport(output) {
        events.push(["write", output]);
        return reportReceipt;
      },
      assertGate() {
        events.push(["gate"]);
      },
      revalidateCandidate(receipt) {
        assert.equal(receipt, candidateReceipt);
        events.push(["candidate"]);
      },
      revalidateChecksum(receipt, candidatePath) {
        assert.equal(receipt, checksumReceipt);
        assert.equal(candidatePath, candidateReceipt.path);
        events.push(["checksum"]);
      },
      revalidateProvenance(receipt) {
        assert.equal(receipt, provenanceReceipt);
        events.push(["provenance"]);
      },
      revalidateReport(receipt, hooks) {
        assert.equal(receipt, reportReceipt);
        events.push(["report-open"]);
        hooks.afterOpen();
        events.push(["report-close"]);
      }
    }),
    reportReceipt
  );
  assert.deepEqual(events, [
    ["write", resolve("private", "report.json")],
    ["gate"],
    ["candidate"],
    ["checksum"],
    ["provenance"],
    ["report-open"],
    ["candidate"],
    ["checksum"],
    ["provenance"],
    ["report-close"],
    ["candidate"],
    ["checksum"],
    ["provenance"]
  ]);
});

test("release publication retains and jointly verifies evidence when the numeric gate fails", () => {
  const events = [];
  const gateError = new Error("numeric performance gate failed");
  assert.throws(
    () =>
      publishInstalledPerformanceReleaseResult({
        output: resolve("private", "report.json"),
        result: { protocol: "test" },
        publicCandidateReceipt: { path: resolve("release", "openwrangler.vsix") },
        publicChecksumReceipt: {
          marker: "checksum",
          path: resolve("release", "openwrangler.vsix.sha256")
        },
        publicProvenanceReceipt: {
          marker: "provenance",
          path: resolve("release", "openwrangler.vsix.provenance.json")
        },
        writeReport() {
          events.push("write");
          return { marker: "report" };
        },
        assertGate() {
          events.push("gate");
          throw gateError;
        },
        revalidateCandidate() {
          events.push("candidate");
        },
        revalidateChecksum() {
          events.push("checksum");
        },
        revalidateProvenance() {
          events.push("provenance");
        },
        revalidateReport(_receipt, hooks) {
          events.push("report-open");
          hooks.afterOpen();
          events.push("report-close");
        }
      }),
    (error) => error === gateError
  );
  assert.deepEqual(events, [
    "write",
    "gate",
    "candidate",
    "checksum",
    "provenance",
    "report-open",
    "candidate",
    "checksum",
    "provenance",
    "report-close",
    "candidate",
    "checksum",
    "provenance"
  ]);
});

test("release publication rejects a report validator that cannot expose the joint read window", () => {
  assert.throws(
    () =>
      publishInstalledPerformanceReleaseResult({
        output: resolve("private", "report.json"),
        result: { protocol: "test" },
        publicCandidateReceipt: {
          marker: "candidate",
          path: resolve("release", "openwrangler.vsix")
        },
        writeReport: () => ({ marker: "report" }),
        assertGate() {},
        revalidateCandidate() {},
        revalidateReport() {}
      }),
    /could not jointly validate its candidate and report/u
  );
});

test("the VSIX snapshot rejects symbolic and hard-linked candidates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const symbolic = join(directory, "symbolic.vsix");
    const hard = join(directory, "hard.vsix");
    await writeFile(source, "candidate");
    await symlink(source, symbolic);
    assert.throws(
      () => stageInstalledPerformanceVsix(symbolic, join(directory, "symbolic-copy.vsix")),
      /single-link regular VSIX|changed before it was staged/u
    );
    await link(source, hard);
    assert.throws(
      () => stageInstalledPerformanceVsix(source, join(directory, "hard-copy.vsix")),
      /single-link regular VSIX|changed before it was staged/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the VSIX snapshot rejects source substitution after descriptor acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "candidate.vsix");
    const retained = join(directory, "retained.vsix");
    const destination = join(directory, "private", "candidate.vsix");
    await writeFile(source, "original candidate");

    assert.throws(
      () =>
        stageInstalledPerformanceVsix(source, destination, {
          afterSourceOpen(openedPath) {
            renameSync(openedPath, retained);
            writeFileSync(openedPath, "substituted candidate");
          }
        }),
      /changed before it was staged/u
    );
    assert.equal(await readFile(source, "utf8"), "substituted candidate");
    await assert.rejects(readFile(destination), /ENOENT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads reject symlinks and path substitution while retaining the replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    const retained = join(directory, "retained.json");
    const symbolic = join(directory, "symbolic.json");
    await writeFile(source, JSON.stringify({ value: "original" }));
    await symlink(source, symbolic);

    assert.throws(() => readBoundedJson(symbolic, 1024), /invalid bounded JSON|changed before/u);
    assert.throws(
      () =>
        readBoundedJson(source, 1024, {
          afterOpen(openedPath) {
            renameSync(openedPath, retained);
            writeFileSync(openedPath, JSON.stringify({ value: "substituted" }));
          }
        }),
      /changed while it was read/u
    );
    assert.deepEqual(JSON.parse(await readFile(source, "utf8")), { value: "substituted" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads reject a same-inode rewrite after descriptor validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    await writeFile(source, JSON.stringify({ value: "original" }));

    assert.throws(
      () =>
        readBoundedJson(source, 1024, {
          afterOpen(openedPath) {
            writeFileSync(openedPath, JSON.stringify({ value: "replacement-with-a-different-byte-size" }));
          }
        }),
      /changed while it was read/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded JSON reads use the shared strict parser and reject nested or escaped duplicate keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const source = join(directory, "phase.json");
    for (const contents of [
      '{"protocol":"openwrangler-installed-performance-phase-v4","protocol":"drifted"}',
      '{"outer":{"phase":"expected","phase":"drifted"}}',
      '{"outer":{"phase":"expected","ph\\u0061se":"drifted"}}'
    ]) {
      await writeFile(source, contents);
      assert.throws(() => readBoundedJson(source, 1024), /must not contain duplicate keys/u);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("phase fragments must match the exact editor-host artifact receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-fragment-"));
  try {
    const source = join(directory, "phase.json");
    const contents = Buffer.from('{"protocol":"openwrangler-installed-performance-phase-v4"}', "utf8");
    await writeFile(source, contents);
    const receipt = {
      protocol: EDITOR_ACCEPTANCE_ARTIFACT_RECEIPT_PROTOCOL,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex")
    };

    assert.deepEqual(readInstalledPerformanceFragment(source, 1024, receipt), {
      protocol: "openwrangler-installed-performance-phase-v4"
    });
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, sha256: "0".repeat(64) }),
      /does not match its editor-host artifact receipt/u
    );
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, unexpected: true }),
      /invalid artifact receipt/u
    );
    assert.throws(
      () => readInstalledPerformanceFragment(source, 1024, { ...receipt, protocol: "unknown" }),
      /invalid artifact receipt/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the installed performance result writer replaces only a regular destination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ow-installed-performance-"));
  try {
    const destination = join(directory, "results", "installed-performance.json");
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 1 });
    writeInstalledPerformanceRun(destination, { protocol: "test", value: 2 });
    assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), { protocol: "test", value: 2 });

    const linked = join(directory, "linked.json");
    await mkdir(join(directory, "target"));
    await symlink(destination, linked);
    assert.throws(
      () => writeInstalledPerformanceRun(linked, { protocol: "test" }),
      /absent or a single-link regular file/u
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("measured editor phases attach after spawn and sample only after verified phase cleanup", async () => {
  const events = [];
  const child = { pid: 4812 };
  const artifactReceipt = { protocol: "receipt" };
  const returned = await runInstalledMeasuredEditorPhase({
    phase: "perf-parquet-warm",
    sampler: {
      begin(phase, processGroupId) {
        events.push(["begin", phase, processGroupId]);
      },
      end() {
        events.push(["end"]);
      }
    },
    spawnOwned() {
      events.push(["spawn"]);
      return child;
    },
    async runPhase(spawnProcess) {
      assert.equal(spawnProcess("editor", [], {}), child);
      events.push(["phase-clean"]);
      return artifactReceipt;
    }
  });
  assert.equal(returned, artifactReceipt);
  assert.deepEqual(events, [["spawn"], ["begin", "perf-parquet-warm", 4812], ["phase-clean"], ["end"]]);
});

test("RSS attachment faults never interrupt editor cleanup and aggregate with phase faults", async () => {
  const phaseError = new Error("phase cleanup failed");
  const samplerError = new Error("sampler attach failed");
  let phaseContinued = false;
  await assert.rejects(
    runInstalledMeasuredEditorPhase({
      phase: "perf-csv-cold",
      sampler: {
        begin() {
          throw samplerError;
        },
        end() {
          assert.fail("a sampler that never attached must not be ended");
        }
      },
      spawnOwned() {
        return { pid: 912 };
      },
      async runPhase(spawnProcess) {
        spawnProcess("editor", [], {});
        phaseContinued = true;
        throw phaseError;
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors.includes(phaseError) &&
      error.errors.includes(samplerError)
  );
  assert.equal(phaseContinued, true);
});
