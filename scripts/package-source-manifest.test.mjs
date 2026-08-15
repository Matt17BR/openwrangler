import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PACKAGE_SOURCE_MANIFEST_PROTOCOL,
  buildPackageSourceManifest,
  parsePackageSourceManifest,
  readGitTrackedModes,
  serializePackageSourceManifest,
  validatePackageSourceManifest
} from "./package-source-manifest.mjs";

const objectId = "1".repeat(40);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function archivePathForSource(path) {
  if (path === "README.md") return "extension/readme.md";
  return `extension/${path}`;
}

function sourceReceipt(path, contents) {
  const bytes = Buffer.byteLength(contents);
  return {
    path,
    archiveEntry: archivePathForSource(path),
    bytes,
    sha256: sha256(contents),
    fileIdentity: {
      dev: 1n,
      ino: BigInt(bytes + path.length),
      size: BigInt(bytes),
      mtimeNs: 2n,
      ctimeNs: 3n
    }
  };
}

function fixture() {
  const trackedFiles = [
    sourceReceipt("README.md", "# Open Wrangler\n"),
    sourceReceipt("r/openwrangler_runtime/frame_contract.R", "identity <- function(value) value\n")
  ];
  const generatedFiles = [sourceReceipt("dist/extension/activate.js", '"use strict";\n')];
  const metadata = new Map([
    ["[Content_Types].xml", "<Types></Types>\n"],
    ["extension.vsixmanifest", "<PackageManifest></PackageManifest>\n"]
  ]);
  const sourceContents = new Map([
    ["README.md", "# Open Wrangler\n"],
    ["r/openwrangler_runtime/frame_contract.R", "identity <- function(value) value\n"],
    ["dist/extension/activate.js", '"use strict";\n']
  ]);
  const archiveEntries = [
    "extension/readme.md",
    "extension.vsixmanifest",
    "extension/r/openwrangler_runtime/frame_contract.R",
    "[Content_Types].xml",
    "extension/dist/extension/activate.js"
  ];
  const archiveValues = new Map(
    archiveEntries.map((archivePath) => {
      const source = [...sourceContents].find(([path]) => archivePathForSource(path) === archivePath)?.[1];
      return [archivePath, source ?? metadata.get(archivePath)];
    })
  );
  return {
    packageSource: {
      packageFiles: ["README.md", "dist/extension/activate.js", "r/openwrangler_runtime/frame_contract.R"],
      trackedFiles,
      generatedFiles
    },
    archive: {
      archiveEntries,
      entryDigests: [...archiveValues].reverse().map(([path, value]) => [path, sha256(value)]),
      entrySizes: [...archiveValues].map(([path, value]) => [path, Buffer.byteLength(value)]),
      entryCount: archiveEntries.length,
      packagedPackageJson: "ignored inspected payload"
    },
    trackedModes: new Map([
      ["package.json", "100644"],
      ["r/openwrangler_runtime/frame_contract.R", "100755"],
      ["README.md", "100644"]
    ])
  };
}

function cloneManifest(manifest) {
  return structuredClone(manifest);
}

function sourceEntry(manifest, sourcePath) {
  const entry = manifest.entries.find((candidate) => candidate.sourcePath === sourcePath);
  assert.ok(entry);
  return entry;
}

test("package-source manifest binds portable sources, Git modes, VSIX bytes, and exact VSCE metadata", () => {
  const input = fixture();
  const manifest = buildPackageSourceManifest(input);
  assert.equal(manifest.protocol, PACKAGE_SOURCE_MANIFEST_PROTOCOL);
  assert.deepEqual(
    manifest.entries.map(({ archivePath }) => archivePath),
    [
      "[Content_Types].xml",
      "extension.vsixmanifest",
      "extension/dist/extension/activate.js",
      "extension/r/openwrangler_runtime/frame_contract.R",
      "extension/readme.md"
    ]
  );
  assert.deepEqual(
    manifest.entries.slice(0, 2).map(({ sourcePath, sourceKind, mode }) => [sourcePath, sourceKind, mode]),
    [
      [null, null, "100644"],
      [null, null, "100644"]
    ]
  );
  assert.equal(sourceEntry(manifest, "README.md").mode, "100644");
  assert.equal(sourceEntry(manifest, "r/openwrangler_runtime/frame_contract.R").mode, "100755");
  assert.equal(sourceEntry(manifest, "dist/extension/activate.js").mode, "100644");
  assert.deepEqual(manifest.totals, {
    archiveEntries: 5,
    archiveBytes: manifest.entries.reduce((total, entry) => total + entry.bytes, 0),
    packageSources: 3,
    packageSourceBytes: manifest.entries
      .filter(({ sourcePath }) => sourcePath !== null)
      .reduce((total, entry) => total + entry.bytes, 0),
    vsceMetadataEntries: 2,
    vsceMetadataBytes: manifest.entries
      .filter(({ sourcePath }) => sourcePath === null)
      .reduce((total, entry) => total + entry.bytes, 0)
  });
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.entries));
  assert.ok(manifest.entries.every(Object.isFrozen));
  assert.ok(Object.isFrozen(manifest.totals));
});

test("canonical serialization is stable, newline-terminated, strict, and contains no local provenance", () => {
  const input = fixture();
  const first = buildPackageSourceManifest(input);
  const firstBytes = serializePackageSourceManifest(first);
  const secondInput = fixture();
  secondInput.packageSource.trackedFiles[0].fileIdentity = {
    dev: 999n,
    ino: 998n,
    size: BigInt(secondInput.packageSource.trackedFiles[0].bytes),
    mtimeNs: 997n,
    ctimeNs: 996n
  };
  secondInput.archive.archiveEntries.reverse();
  secondInput.archive.entryDigests.reverse();
  secondInput.archive.entrySizes.reverse();
  secondInput.trackedModes = new Map([...secondInput.trackedModes].reverse());
  const secondBytes = serializePackageSourceManifest(buildPackageSourceManifest(secondInput));
  assert.deepEqual(secondBytes, firstBytes);
  assert.equal(firstBytes.at(-1), 0x0a);
  assert.doesNotMatch(firstBytes.toString("utf8"), /(?:commit|fileIdentity|mtime|ctime|uid|gid|\/tmp\/|\\)/u);
  assert.deepEqual(parsePackageSourceManifest(firstBytes), first);
  assert.deepEqual(parsePackageSourceManifest(firstBytes.toString("utf8")), first);
});

test("binding validation proves the manifest still matches all three inspected inputs", () => {
  const input = fixture();
  const manifest = buildPackageSourceManifest(input);
  assert.deepEqual(validatePackageSourceManifest(manifest, input), manifest);

  const modeDrift = fixture();
  modeDrift.trackedModes.set("r/openwrangler_runtime/frame_contract.R", "100644");
  assert.throws(
    () => validatePackageSourceManifest(manifest, modeDrift),
    /drifted from its pinned package sources or inspected VSIX/u
  );

  const metadataDrift = fixture();
  metadataDrift.archive.entryDigests = metadataDrift.archive.entryDigests.map(([path, digest]) => [
    path,
    path === "extension.vsixmanifest" ? "a".repeat(64) : digest
  ]);
  assert.throws(
    () => validatePackageSourceManifest(manifest, metadataDrift),
    /drifted from its pinned package sources or inspected VSIX/u
  );
  assert.throws(
    () => validatePackageSourceManifest(manifest, { ...input, unexpected: true }),
    /exact contract fields/u
  );
});

test("parser rejects duplicate JSON keys and every noncanonical byte representation", () => {
  const manifest = buildPackageSourceManifest(fixture());
  const canonical = serializePackageSourceManifest(manifest).toString("utf8");
  const duplicate = canonical.replace("{\n", `{\n  "protocol": "${PACKAGE_SOURCE_MANIFEST_PROTOCOL}",\n`);
  assert.throws(() => parsePackageSourceManifest(duplicate), /duplicate keys/iu);
  assert.throws(() => parsePackageSourceManifest(JSON.stringify(manifest)), /not in canonical JSON form/u);
  assert.throws(() => parsePackageSourceManifest(`${canonical}\n`), /not in canonical JSON form/u);
  assert.throws(() => parsePackageSourceManifest(Buffer.from([0xff])), /valid UTF-8/u);
  assert.throws(() => parsePackageSourceManifest(Buffer.alloc(4 * 1024 * 1024 + 1)), /bounded byte size/u);
  assert.throws(() => parsePackageSourceManifest(42), /UTF-8 bytes or text/u);
});

test("validator rejects extra or missing fields at every contract level", () => {
  const manifest = buildPackageSourceManifest(fixture());
  for (const mutate of [
    (value) => {
      value.extra = true;
    },
    (value) => {
      delete value.protocol;
    },
    (value) => {
      value.entries[0].extra = true;
    },
    (value) => {
      delete value.entries[0].sha256;
    },
    (value) => {
      value.totals.extra = 0;
    },
    (value) => {
      delete value.totals.archiveBytes;
    }
  ]) {
    const changed = cloneManifest(manifest);
    mutate(changed);
    assert.throws(() => validatePackageSourceManifest(changed), /exact contract fields/u);
  }
  const wrongProtocol = cloneManifest(manifest);
  wrongProtocol.protocol = "openwrangler-package-source-manifest-v2";
  assert.throws(() => validatePackageSourceManifest(wrongProtocol), /protocol is unsupported/u);
});

test("validator rejects unsafe, non-normalized, absolute, and traversal paths", () => {
  const manifest = buildPackageSourceManifest(fixture());
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
    const changed = cloneManifest(manifest);
    sourceEntry(changed, "README.md").sourcePath = path;
    assert.throws(() => validatePackageSourceManifest(changed), /normalized portable relative path/u);
  }
});

test("validator rejects noncanonical order, duplicate and case-colliding archive paths, and source collisions", () => {
  const manifest = buildPackageSourceManifest(fixture());
  const reordered = cloneManifest(manifest);
  [reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]];
  assert.throws(() => validatePackageSourceManifest(reordered), /bytewise archive-path order/u);

  const duplicate = cloneManifest(manifest);
  duplicate.entries[1] = structuredClone(duplicate.entries[0]);
  assert.throws(() => validatePackageSourceManifest(duplicate), /duplicate, case-colliding, or file-ancestor/u);

  const caseCollision = cloneManifest(manifest);
  const copied = structuredClone(sourceEntry(caseCollision, "r/openwrangler_runtime/frame_contract.R"));
  copied.archivePath = "extension/R/openwrangler_runtime/frame_contract.R";
  copied.sourcePath = "R/openwrangler_runtime/frame_contract.R";
  caseCollision.entries.push(copied);
  caseCollision.entries.sort((left, right) =>
    Buffer.compare(Buffer.from(left.archivePath), Buffer.from(right.archivePath))
  );
  assert.throws(() => validatePackageSourceManifest(caseCollision), /duplicate, case-colliding, or file-ancestor/u);
});

test("validator rejects mode, digest, metadata, and aggregate-accounting drift", () => {
  const manifest = buildPackageSourceManifest(fixture());
  const mutations = [
    {
      mutate(value) {
        sourceEntry(value, "README.md").mode = "100600";
      },
      pattern: /noncanonical portable mode/u
    },
    {
      mutate(value) {
        sourceEntry(value, "dist/extension/activate.js").mode = "100755";
      },
      pattern: /noncanonical portable mode/u
    },
    {
      mutate(value) {
        value.entries[0].mode = "100755";
      },
      pattern: /exact portable contract/u
    },
    {
      mutate(value) {
        value.entries[0].sha256 = value.entries[0].sha256.toUpperCase();
      },
      pattern: /lowercase SHA-256/u
    },
    {
      mutate(value) {
        value.entries.shift();
      },
      pattern: /exactly both VSCE-generated metadata/u
    },
    {
      mutate(value) {
        value.totals.archiveBytes += 1;
      },
      pattern: /aggregate accounting is inconsistent/u
    }
  ];
  for (const { mutate, pattern } of mutations) {
    const changed = cloneManifest(manifest);
    mutate(changed);
    assert.throws(() => validatePackageSourceManifest(changed), pattern);
  }
});

test("builder rejects missing, extra, duplicate, or malformed package sources", () => {
  const cases = [
    {
      mutate(input) {
        input.packageSource.trackedFiles.pop();
      },
      pattern: /missing or adds one package source/u
    },
    {
      mutate(input) {
        input.packageSource.packageFiles.push("package.json");
      },
      pattern: /missing or adds one package source/u
    },
    {
      mutate(input) {
        input.packageSource.packageFiles.push("readme.md");
      },
      pattern: /duplicate, case-colliding, or file-ancestor/u
    },
    {
      mutate(input) {
        input.packageSource.generatedFiles[0].archiveEntry = "extension/wrong.js";
      },
      pattern: /does not map one unique package source/u
    },
    {
      mutate(input) {
        input.packageSource.generatedFiles[0].bytes = 0;
        input.packageSource.generatedFiles[0].fileIdentity.size = 0n;
      },
      pattern: /bounded byte size/u
    },
    {
      mutate(input) {
        delete input.packageSource.trackedFiles[0].fileIdentity;
      },
      pattern: /pinned file identity/u
    },
    {
      mutate(input) {
        input.trackedModes.delete("README.md");
      },
      pattern: /missing one tracked Git index mode/u
    },
    {
      mutate(input) {
        input.trackedModes.set("README.md", "120000");
      },
      pattern: /portable regular-file modes/u
    }
  ];
  for (const { mutate, pattern } of cases) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildPackageSourceManifest(input), pattern);
  }
});

test("builder rejects missing, extra, colliding, incomplete, or drifting VSIX inventories", () => {
  const cases = [
    {
      mutate(input) {
        input.archive.archiveEntries.pop();
      },
      pattern: /same paths/u
    },
    {
      mutate(input) {
        input.archive.archiveEntries.push("extension/extra.js");
        input.archive.entryDigests.push(["extension/extra.js", "a".repeat(64)]);
        input.archive.entrySizes.push(["extension/extra.js", 1]);
        input.archive.entryCount += 1;
      },
      pattern: /missing or adds one package source or VSCE metadata/u
    },
    {
      mutate(input) {
        input.archive.entryDigests.push(structuredClone(input.archive.entryDigests[0]));
      },
      pattern: /duplicate archive path/u
    },
    {
      mutate(input) {
        const item = input.archive.entryDigests.find(([path]) => path === "extension/readme.md");
        item[1] = "b".repeat(64);
      },
      pattern: /bytes drifted/u
    },
    {
      mutate(input) {
        const item = input.archive.entrySizes.find(([path]) => path === "extension/readme.md");
        item[1] += 1;
      },
      pattern: /bytes drifted/u
    },
    {
      mutate(input) {
        input.archive.archiveEntries.push("extension/README.md");
      },
      pattern: /duplicate, case-colliding, or file-ancestor/u
    },
    {
      mutate(input) {
        input.archive.entryCount += 1;
      },
      pattern: /entry count is inconsistent/u
    }
  ];
  for (const { mutate, pattern } of cases) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildPackageSourceManifest(input), pattern);
  }
});

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
