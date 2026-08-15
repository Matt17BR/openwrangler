import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  isPortableHostPackageFileMode,
  isPrivatePackagingDirectoryMode,
  packageCurrentChannel,
  resolveCurrentChannelPackageArguments
} from "./package-current-channel.mjs";
import { parsePackageSourceManifest, validatePackageSourceManifest } from "./package-source-manifest.mjs";

function manifest(version, preview) {
  return JSON.stringify({ preview, version });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const RAW_BYTES = Buffer.from("raw-vsix-candidate", "utf8");
const CANONICAL_BYTES = Buffer.from("canonical-vsix-candidate", "utf8");
const SOURCE_BYTES = Buffer.from("package source\n", "utf8");
const SOURCE_SHA256 = sha256(SOURCE_BYTES);
const CONTENT_TYPES_SHA256 = sha256("content-types");
const VSIX_MANIFEST_SHA256 = sha256("vsix-manifest");

function sourceReceipt({ ctimeNs = 5n, sourcePath = "source.txt" } = {}) {
  return Object.freeze({
    packageFiles: Object.freeze([sourcePath]),
    trackedFiles: Object.freeze([
      Object.freeze({
        archiveEntry: `extension/${sourcePath}`,
        bytes: SOURCE_BYTES.length,
        fileIdentity: Object.freeze({
          ctimeNs,
          dev: 1n,
          ino: 2n,
          mtimeNs: 4n,
          size: BigInt(SOURCE_BYTES.length)
        }),
        path: sourcePath,
        sha256: SOURCE_SHA256
      })
    ]),
    generatedFiles: Object.freeze([])
  });
}

function archiveInspection(sourcePath = "source.txt") {
  return Object.freeze({
    archiveEntries: Object.freeze(["[Content_Types].xml", "extension.vsixmanifest", `extension/${sourcePath}`]),
    entryCount: 3,
    entryDigests: Object.freeze([
      Object.freeze(["[Content_Types].xml", CONTENT_TYPES_SHA256]),
      Object.freeze(["extension.vsixmanifest", VSIX_MANIFEST_SHA256]),
      Object.freeze([`extension/${sourcePath}`, SOURCE_SHA256])
    ]),
    entrySizes: Object.freeze([
      Object.freeze(["[Content_Types].xml", 13]),
      Object.freeze(["extension.vsixmanifest", 13]),
      Object.freeze([`extension/${sourcePath}`, SOURCE_BYTES.length])
    ])
  });
}

function canonicalReceipt(sourceBytes = RAW_BYTES) {
  return Object.freeze({
    canonicalBytes: CANONICAL_BYTES.length,
    canonicalSha256: sha256(CANONICAL_BYTES),
    entryCount: 3,
    inventorySha256: "a".repeat(64),
    protocol: "openwrangler-reproducible-vsix-v1",
    sourceBytes: sourceBytes.length,
    sourceSha256: sha256(sourceBytes),
    uncompressedBytes: 39
  });
}

function makeFixture({
  hooks,
  output = "candidate.vsix",
  pinReceipts = [sourceReceipt()],
  sourcePath = "source.txt",
  version = "1.99.7",
  preview = true,
  dependencyOverrides = {}
} = {}) {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "ow-package-current-channel-"));
  writeFileSync(join(repositoryRoot, sourcePath), SOURCE_BYTES, { flag: "wx", mode: 0o600 });
  const calls = {
    canonicalAssertions: 0,
    inspections: 0,
    manifests: 0,
    sourcePins: 0,
    validations: 0,
    vsce: []
  };
  const inspection = archiveInspection(sourcePath);
  const receipt = canonicalReceipt();
  const dependencies = {
    async assertCanonicalArchive(bytes) {
      calls.canonicalAssertions += 1;
      assert.deepEqual(bytes, CANONICAL_BYTES);
      return canonicalReceipt(CANONICAL_BYTES);
    },
    async assertPackageSources() {
      const index = Math.min(calls.sourcePins, pinReceipts.length - 1);
      calls.sourcePins += 1;
      return pinReceipts[index];
    },
    buildSourceManifest(bindings) {
      calls.manifests += 1;
      assert.equal(bindings.packageSource, pinReceipts[0]);
      assert.equal(bindings.archive, inspection);
      assert.deepEqual(bindings.trackedModes, new Map([[sourcePath, "100644"]]));
      return Object.freeze({ entries: Object.freeze([]), protocol: "test-package-source-manifest" });
    },
    async canonicalizeArchive(bytes) {
      assert.deepEqual(bytes, RAW_BYTES);
      return Object.freeze({ bytes: Buffer.from(CANONICAL_BYTES), receipt });
    },
    async createVsix(options) {
      calls.vsce.push(Object.freeze({ ...options }));
      writeFileSync(options.packagePath, RAW_BYTES, { flag: "wx", mode: 0o600 });
    },
    hooks,
    async inspectArchive() {
      calls.inspections += 1;
      return inspection;
    },
    pinGitModes() {
      return new Map([[sourcePath, "100644"]]);
    },
    serializeSourceManifest(value) {
      return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    },
    validateSourceManifest(value, bindings) {
      calls.validations += 1;
      assert.deepEqual(value, { entries: [], protocol: "test-package-source-manifest" });
      assert.deepEqual(bindings.trackedModes, new Map([[sourcePath, "100644"]]));
      return value;
    },
    ...dependencyOverrides
  };
  const arguments_ = ["--out", output];
  return {
    arguments_,
    calls,
    dependencies,
    outputPath: resolve(repositoryRoot, output),
    packageJson: manifest(version, preview),
    repositoryRoot
  };
}

async function runFixture(fixture, arguments_ = fixture.arguments_) {
  return packageCurrentChannel(
    {
      arguments_,
      packageJson: fixture.packageJson,
      repositoryRoot: fixture.repositoryRoot
    },
    fixture.dependencies
  );
}

function removeFixture(fixture) {
  rmSync(fixture.repositoryRoot, { force: true, recursive: true });
}

function assertNoProducedOutput(fixture) {
  assert.throws(() => lstatSync(fixture.outputPath), { code: "ENOENT" });
}

test("derives preview and stable VSCE arguments from validated package metadata", () => {
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("0.3.0", true)
    }),
    ["package", "--no-gitHubIssueLinking", "--pre-release", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--pre-release", "--out", "openwrangler.vsix"],
      packageJson: manifest("0.3.0", true)
    }),
    ["package", "--no-gitHubIssueLinking", "--pre-release", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("1.99.0", true)
    }),
    ["package", "--no-gitHubIssueLinking", "--pre-release", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("1.0.0", false)
    }),
    ["package", "--no-gitHubIssueLinking", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("1.1.0", false)
    }),
    ["package", "--no-gitHubIssueLinking", "--out", "openwrangler.vsix"]
  );
});

test("packages preview and stable channels with exact locked VSCE options and canonical one-link outputs", async () => {
  for (const channel of [
    { version: "1.99.7", preview: true, leading: true },
    { version: "2.0.0", preview: false, leading: false }
  ]) {
    let privateDirectory;
    const fixture = makeFixture({
      ...channel,
      hooks: {
        afterPrivateDirectoryCreated(context) {
          privateDirectory = context.privatePath;
          assert.equal(isPrivatePackagingDirectoryMode(lstatSync(context.privatePath, { bigint: true }).mode), true);
        }
      }
    });
    try {
      const arguments_ = [...(channel.leading ? ["--pre-release"] : []), "--out", "candidate.vsix"];
      const result = await runFixture(fixture, arguments_);
      assert.deepEqual(fixture.calls.vsce, [
        {
          allowMissingRepository: false,
          allowStarActivation: false,
          cwd: fixture.repositoryRoot,
          gitHubIssueLinking: false,
          packagePath: join(privateDirectory, "raw-candidate.vsix"),
          preRelease: channel.preview
        }
      ]);
      assert.deepEqual(readFileSync(fixture.outputPath), CANONICAL_BYTES);
      assert.equal(lstatSync(fixture.outputPath).nlink, 1);
      assert.equal(isPortableHostPackageFileMode(lstatSync(fixture.outputPath, { bigint: true }).mode), true);
      assert.equal(result.path, fixture.outputPath);
      assert.equal(result.sha256, sha256(CANONICAL_BYTES));
      assert.equal(result.packageSourceManifestProtocol, "test-package-source-manifest");
      assert.equal(result.packageSourceManifestEntries, 0);
      assert.match(result.packageSourceManifestSha256, /^[0-9a-f]{64}$/u);
      assert.ok(result.packageSourceManifestBytes > 0);
      const returnedManifest = Buffer.from(result.packageSourceManifest, "utf8");
      assert.equal(returnedManifest.length, result.packageSourceManifestBytes);
      assert.equal(sha256(returnedManifest), result.packageSourceManifestSha256);
      assert.deepEqual(JSON.parse(result.packageSourceManifest), {
        entries: [],
        protocol: "test-package-source-manifest"
      });
      assert.equal(fixture.calls.canonicalAssertions, 2, "staged and final bytes must both prove canonical form");
      assert.equal(fixture.calls.sourcePins, 4, "sources must be pinned before, after raw, after canonical, and final");
      assert.equal(fixture.calls.manifests, 1);
      assert.equal(fixture.calls.validations, 2);
      assert.deepEqual(
        readdirSync(fixture.repositoryRoot).sort(),
        ["candidate.vsix", "source.txt"],
        "private package files must be gone before success"
      );
    } finally {
      removeFixture(fixture);
    }
  }
});

test("uses exact POSIX modes and Windows' writable-bit file-mode contract", () => {
  assert.equal(isPrivatePackagingDirectoryMode(0o40700n, { platform: "linux" }), true);
  assert.equal(isPrivatePackagingDirectoryMode(0o40750n, { platform: "linux" }), false);
  assert.equal(isPrivatePackagingDirectoryMode(0o40777n, { platform: "win32" }), true);
  assert.equal(isPrivatePackagingDirectoryMode(0o40555n, { platform: "win32" }), false);
  assert.equal(isPortableHostPackageFileMode(0o100644n, { platform: "darwin" }), true);
  assert.equal(isPortableHostPackageFileMode(0o100600n, { platform: "darwin" }), false);
  assert.equal(isPortableHostPackageFileMode(0o100666n, { platform: "win32" }), true);
  assert.equal(isPortableHostPackageFileMode(0o100444n, { platform: "win32" }), false);
  assert.throws(() => isPortableHostPackageFileMode(0o644), /bigint mode/u);
});

test("returns the exact canonical portable manifest bytes without publishing a sidecar", async () => {
  const fixture = makeFixture();
  delete fixture.dependencies.buildSourceManifest;
  delete fixture.dependencies.serializeSourceManifest;
  delete fixture.dependencies.validateSourceManifest;
  try {
    const result = await runFixture(fixture);
    const manifestBytes = Buffer.from(result.packageSourceManifest, "utf8");
    assert.equal(manifestBytes.length, result.packageSourceManifestBytes);
    assert.equal(sha256(manifestBytes), result.packageSourceManifestSha256);
    const parsed = parsePackageSourceManifest(manifestBytes);
    assert.equal(parsed.protocol, result.packageSourceManifestProtocol);
    assert.equal(parsed.entries.length, result.packageSourceManifestEntries);
    assert.deepEqual(
      validatePackageSourceManifest(parsed, {
        packageSource: sourceReceipt(),
        archive: archiveInspection(),
        trackedModes: new Map([["source.txt", "100644"]])
      }),
      parsed
    );
    assert.deepEqual(readdirSync(fixture.repositoryRoot).sort(), ["candidate.vsix", "source.txt"]);
  } finally {
    removeFixture(fixture);
  }
});

test("rejects contradictory metadata and caller-controlled channel overrides", () => {
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: [],
        packageJson: manifest("0.3.0", false)
      }),
    /requires package\.json "preview" to be true/u
  );
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: [],
        packageJson: manifest("1.0.0", true)
      }),
    /requires package\.json "preview" to be false/u
  );
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: ["--pre-release", "--out", "openwrangler.vsix"],
        packageJson: manifest("1.0.0", false)
      }),
    /must not receive --pre-release/u
  );
  for (const arguments_ of [
    ["--pre-release", "--pre-release"],
    ["--pre-release=true", "--out", "openwrangler.vsix"],
    ["--no-pre-release", "--out", "openwrangler.vsix"],
    ["--", "--out", "openwrangler.vsix"],
    ["1.0.0", "--out", "openwrangler.vsix"],
    ["--out", "--pre-release"],
    ["--out", "openwrangler.vsix", "--unknown"]
  ]) {
    assert.throws(
      () =>
        resolveCurrentChannelPackageArguments({
          arguments_,
          packageJson: manifest("0.3.0", true)
        }),
      /must be exactly --out/u
    );
  }
});

test("rejects malformed, duplicate-key, and nonnumeric manifests", () => {
  for (const packageJson of [
    '{"version":"0.3.0","version":"1.0.0","preview":false}',
    "[]",
    manifest("1.0.0-alpha.1", false),
    JSON.stringify({ version: "1.0.0" })
  ]) {
    assert.throws(
      () => resolveCurrentChannelPackageArguments({ arguments_: [], packageJson }),
      /package-current-channel/u
    );
  }
});

test("rejects malformed injected dependencies and unreviewed hooks before creating package files", async () => {
  for (const dependencyOverrides of [{ createVsix: null }, { hooks: null }, { hooks: { unknownHook() {} } }]) {
    const fixture = makeFixture({ dependencyOverrides });
    try {
      await assert.rejects(runFixture(fixture), /dependency createVsix|hooks must/u);
      assertNoProducedOutput(fixture);
      assert.deepEqual(readdirSync(fixture.repositoryRoot).sort(), ["source.txt"]);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("fails closed when a package source mutates or is restored under a new identity", async () => {
  for (const changed of [sourceReceipt({ ctimeNs: 6n }), sourceReceipt({ ctimeNs: 9n })]) {
    const fixture = makeFixture({ pinReceipts: [sourceReceipt(), changed] });
    try {
      await assert.rejects(runFixture(fixture), /package source changed/u);
      assertNoProducedOutput(fixture);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("rejects a raw candidate path swap and a raw hard-link alias without publishing", async () => {
  for (const attack of ["swap", "hardlink"]) {
    const fixture = makeFixture({
      hooks: {
        afterRawCandidateCreated({ privatePath, rawPath }) {
          if (attack === "swap") {
            renameSync(rawPath, join(privatePath, "original-raw.vsix"));
            writeFileSync(rawPath, Buffer.from("substituted", "utf8"), { flag: "wx", mode: 0o600 });
          } else {
            linkSync(rawPath, join(privatePath, "raw-alias.vsix"));
          }
        }
      }
    });
    try {
      await assert.rejects(runFixture(fixture), /Raw VSIX candidate|verified cleanup/u);
      assertNoProducedOutput(fixture);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("refuses existing regular, symbolic-link, and hard-link output names", async () => {
  for (const kind of ["regular", "symlink", "hardlink"]) {
    const fixture = makeFixture();
    const seed = join(fixture.repositoryRoot, "seed.vsix");
    writeFileSync(seed, "user bytes", { flag: "wx", mode: 0o600 });
    if (kind === "regular") writeFileSync(fixture.outputPath, "existing", { flag: "wx", mode: 0o600 });
    if (kind === "symlink") symlinkSync(seed, fixture.outputPath);
    if (kind === "hardlink") linkSync(seed, fixture.outputPath);
    try {
      await assert.rejects(runFixture(fixture), /must not already exist/u);
      assert.notDeepEqual(readFileSync(fixture.outputPath), CANONICAL_BYTES);
      assert.equal(fixture.calls.vsce.length, 0);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("keeps the output separate from package sources and rejects aliased output parents", async () => {
  const sourceOutput = makeFixture({ output: "source.txt" });
  try {
    await assert.rejects(runFixture(sourceOutput), /separate from every package source/u);
    assert.deepEqual(readFileSync(sourceOutput.outputPath), SOURCE_BYTES);
  } finally {
    removeFixture(sourceOutput);
  }

  const fixture = makeFixture({ output: "alias/candidate.vsix" });
  const alias = join(fixture.repositoryRoot, "alias");
  const real = join(fixture.repositoryRoot, "real");
  mkdirSync(real);
  symlinkSync(real, alias);
  try {
    await assert.rejects(runFixture(fixture), /canonical path without symbolic-link aliases/u);
    assert.throws(() => lstatSync(join(real, "candidate.vsix")), { code: "ENOENT" });
  } finally {
    removeFixture(fixture);
  }
});

test("detects an output-parent swap before publication", async () => {
  const fixture = makeFixture();
  const movedRoot = `${fixture.repositoryRoot}-moved`;
  fixture.dependencies.hooks = {
    beforePublish() {
      renameSync(fixture.repositoryRoot, movedRoot);
      mkdirSync(fixture.repositoryRoot, { mode: 0o700 });
    }
  };
  try {
    await assert.rejects(runFixture(fixture), /output parent changed identity|verified cleanup/u);
    assertNoProducedOutput(fixture);
  } finally {
    rmSync(fixture.repositoryRoot, { force: true, recursive: true });
    if (lstatSync(movedRoot).isDirectory()) renameSync(movedRoot, fixture.repositoryRoot);
    removeFixture(fixture);
  }
});

test("link publication failures and ambiguous post-link failures leave no produced output", async () => {
  for (const partial of [false, true]) {
    const fixture = makeFixture({
      dependencyOverrides: {
        linkFile(source, destination) {
          if (partial) linkSync(source, destination);
          const error = new Error(partial ? "ambiguous link failure" : "link unsupported");
          error.code = partial ? "EIO" : "EOPNOTSUPP";
          throw error;
        }
      }
    });
    try {
      await assert.rejects(runFixture(fixture), /link (?:failure|unsupported)/u);
      assertNoProducedOutput(fixture);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("a post-link staging-unlink failure rolls back the public name", async () => {
  const fixture = makeFixture({
    dependencyOverrides: {
      unlinkFile() {
        throw new Error("staging unlink failed");
      }
    }
  });
  try {
    await assert.rejects(runFixture(fixture), /staging unlink failed/u);
    assertNoProducedOutput(fixture);
  } finally {
    removeFixture(fixture);
  }
});

test("a substituted public name is retained but never mistaken for the canonical output", async () => {
  const replacement = Buffer.from("user replacement", "utf8");
  const fixture = makeFixture({
    hooks: {
      afterLink({ output }) {
        unlinkSync(output);
        writeFileSync(output, replacement, { flag: "wx", mode: 0o600 });
      }
    }
  });
  try {
    await assert.rejects(
      runFixture(fixture),
      /changed before staging-name retirement|refused a substituted path|Canonical package creation/u
    );
    assert.deepEqual(readFileSync(fixture.outputPath), replacement);
  } finally {
    removeFixture(fixture);
  }
});

test("final validation rejects any surviving hard-link alias and removes the requested output", async () => {
  let extraLink;
  const fixture = makeFixture({
    hooks: {
      afterStagingUnlink({ output, privatePath }) {
        extraLink = join(privatePath, "unexpected-alias.vsix");
        linkSync(output, extraLink);
      }
    }
  });
  try {
    await assert.rejects(runFixture(fixture), /one name|verified cleanup/u);
    assertNoProducedOutput(fixture);
    assert.equal(lstatSync(extraLink).nlink, 1);
  } finally {
    removeFixture(fixture);
  }
});

test("write and private-directory cleanup failures cannot leave a canonical public output", async () => {
  const writeFailure = makeFixture({
    dependencyOverrides: {
      writeCanonicalCandidate() {
        throw new Error("canonical write failed");
      }
    }
  });
  try {
    await assert.rejects(runFixture(writeFailure), /canonical write failed/u);
    assertNoProducedOutput(writeFailure);
  } finally {
    removeFixture(writeFailure);
  }

  const cleanupFailure = makeFixture({
    dependencyOverrides: {
      removeDirectory() {
        throw new Error("private cleanup failed");
      }
    }
  });
  try {
    await assert.rejects(runFixture(cleanupFailure), /private cleanup failed|Canonical package creation/u);
    assertNoProducedOutput(cleanupFailure);
  } finally {
    removeFixture(cleanupFailure);
  }
});
