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
  readGitTrackedModes,
  resolveCurrentChannelPackageArguments
} from "./package-current-channel.mjs";

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
    gitPins: 0,
    sourcePins: 0,
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
      calls.gitPins += 1;
      return new Map([[sourcePath, "100644"]]);
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
      assert.equal(result.bytes, CANONICAL_BYTES.length);
      assert.equal(result.protocol, canonicalReceipt(CANONICAL_BYTES).protocol);
      assert.equal(result.sha256, sha256(CANONICAL_BYTES));
      assert.equal(fixture.calls.canonicalAssertions, 1, "byte-identical publication must reuse its staged proof");
      assert.equal(fixture.calls.sourcePins, 4, "sources must be pinned before, after raw, after canonical, and final");
      assert.equal(
        fixture.calls.gitPins,
        2,
        "the complete index must be validated before creation and at final binding"
      );
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

test("final byte validation rejects corrupted or truncated output and cleans up its owned files", async () => {
  for (const truncated of [false, true]) {
    const changed = Buffer.from(CANONICAL_BYTES);
    changed[Math.floor(changed.length / 2)] ^= 1;
    const replacement = truncated ? CANONICAL_BYTES.subarray(0, -1) : changed;
    const fixture = makeFixture({
      hooks: {
        afterStagingUnlink({ output }) {
          // The final identity is captured after this write, so only byte
          // validation can distinguish it from the verified staged snapshot.
          writeFileSync(output, replacement);
        }
      }
    });
    try {
      await assert.rejects(runFixture(fixture), /Published package output changed after atomic publication/u);
      assertNoProducedOutput(fixture);
      assert.deepEqual(readdirSync(fixture.repositoryRoot), ["source.txt"]);
    } finally {
      removeFixture(fixture);
    }
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

const objectId = "1".repeat(40);

test("Git tracked-mode reader uses one bounded NUL stage inventory and returns portable modes", () => {
  let invocation;
  const trackedModes = readGitTrackedModes({
    cwd: "/repository",
    runGit(command, arguments_, options) {
      invocation = { command, arguments_, options };
      return Buffer.from(
        `100644 ${objectId} 0\tREADME.md\0` + `100755 ${"2".repeat(64)} 0\tr/openwrangler_runtime/frame_contract.R\0`
      );
    }
  });
  assert.deepEqual(
    [...trackedModes],
    [
      ["README.md", "100644"],
      ["r/openwrangler_runtime/frame_contract.R", "100755"]
    ]
  );
  assert.deepEqual(invocation.command, "git");
  assert.deepEqual(invocation.arguments_, ["ls-files", "--stage", "-z"]);
  assert.equal(invocation.options.cwd, "/repository");
  assert.equal(invocation.options.encoding, "buffer");
  assert.equal(invocation.options.maxBuffer, 16 * 1024 * 1024);
  assert.equal(invocation.options.timeout, 10_000);
});

test("Git tracked-mode reader rejects malformed, unsafe, unresolved, duplicate, and special-mode records", () => {
  const outputs = [
    [`120000 ${objectId} 0\tlink\0`, /symlink, submodule, or unsupported mode/u],
    [`160000 ${objectId} 0\tsubmodule\0`, /symlink, submodule, or unsupported mode/u],
    [`100644 ${objectId} 1\tconflict\0`, /nonzero index stage/u],
    [`100644 ${objectId} 0\tREADME.md`, /NUL record terminator/u],
    [`not-an-index-record\0`, /malformed index record/u],
    [`100644 ${objectId} 0\t../escape\0`, /normalized portable relative path/u],
    [`100644 ${objectId} 0\tREADME.md\0` + `100755 ${objectId} 0\tREADME.md\0`, /duplicate path/u],
    [
      `100644 ${objectId} 0\tREADME.md\0` + `100644 ${objectId} 0\treadme.md\0`,
      /duplicate, case-colliding, or file-ancestor/u
    ],
    [
      `100644 ${objectId} 0\ta\0` + `100644 ${objectId} 0\ta-b\0` + `100644 ${objectId} 0\ta/c\0`,
      /duplicate, case-colliding, or file-ancestor/u
    ]
  ];
  for (const [output, pattern] of outputs) {
    assert.throws(() => readGitTrackedModes({ runGit: () => output }), pattern);
  }
  assert.throws(() => readGitTrackedModes({ runGit: () => Buffer.from([0xff]) }), /valid UTF-8/u);
  assert.throws(() => readGitTrackedModes({ runGit: () => Buffer.alloc(16 * 1024 * 1024 + 1) }), /byte bound/u);
  assert.throws(() => readGitTrackedModes({ runGit: () => 42 }), /return bytes or text/u);
});

test("Git tracked-mode reader rejects nonportable index paths", () => {
  const unsafePaths = [
    "/absolute",
    "C:/absolute",
    "../escape",
    "a/../escape",
    "a\\b",
    "./dot",
    "double//segment",
    "trailing/",
    "trailing. ",
    "con.txt",
    "cafe\u0301.txt"
  ];
  for (const path of unsafePaths) {
    assert.throws(
      () => readGitTrackedModes({ runGit: () => `100644 ${objectId} 0\t${path}\0` }),
      /normalized portable relative path/u
    );
  }
});

test("pins packaged Git modes while allowing valid unpackaged mode changes", async () => {
  for (const mode of ["100644", "100755"]) {
    let reads = 0;
    const fixture = makeFixture({
      dependencyOverrides: {
        pinGitModes() {
          reads += 1;
          return readGitTrackedModes({
            runGit: () =>
              `${mode} ${objectId} 0\tsource.txt\0` +
              `${reads === 1 ? "100644" : "100755"} ${objectId} 0\tunpackaged.txt\0`
          });
        }
      }
    });
    try {
      const result = await runFixture(fixture);
      assert.equal(reads, 2);
      assert.deepEqual(readFileSync(result.path), CANONICAL_BYTES);
      assert.equal(result.sha256, sha256(CANONICAL_BYTES));
      assert.deepEqual(readdirSync(fixture.repositoryRoot).sort(), ["candidate.vsix", "source.txt"]);
    } finally {
      removeFixture(fixture);
    }
  }
});

test("refuses missing or changed packaged modes and unsafe unpackaged index entries with owned cleanup", async () => {
  const regular = `100644 ${objectId} 0\tsource.txt\0`;
  const executable = `100755 ${objectId} 0\tsource.txt\0`;
  const missing = /missing its tracked Git index mode/u;
  const changed = /Git index mode changed/u;
  const special = /symlink, submodule, or unsupported mode/u;
  const cases = [
    { before: "", after: regular, error: missing, published: false },
    { before: regular, after: "", error: changed, published: true },
    { before: executable, after: regular, error: changed, published: true }
  ];
  for (const mode of ["120000", "160000"]) {
    const unsafe = regular + `${mode} ${objectId} 0\tunpackaged\0`;
    cases.push({ before: unsafe, after: regular, error: special, published: false });
    cases.push({ before: regular, after: unsafe, error: special, published: true });
  }
  for (const { before, after, error, published } of cases) {
    let reads = 0;
    let linked = false;
    const fixture = makeFixture({
      hooks: {
        afterLink() {
          linked = true;
        }
      },
      dependencyOverrides: {
        pinGitModes() {
          reads += 1;
          return readGitTrackedModes({ runGit: () => (reads === 1 ? before : after) });
        }
      }
    });
    try {
      await assert.rejects(runFixture(fixture), error);
      assert.equal(linked, published);
      assert.equal(fixture.calls.vsce.length, published ? 1 : 0);
      assert.equal(reads, published ? 2 : 1);
      assertNoProducedOutput(fixture);
      assert.deepEqual(readFileSync(join(fixture.repositoryRoot, "source.txt")), SOURCE_BYTES);
      assert.deepEqual(readdirSync(fixture.repositoryRoot), ["source.txt"]);
    } finally {
      removeFixture(fixture);
    }
  }
});
