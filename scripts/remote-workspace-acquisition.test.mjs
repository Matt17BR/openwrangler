import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { readBoundedRegularFile } from "./bounded-file-read.mjs";
import {
  assertRemoteAcquisitionRootReceipt,
  assertPinnedRemoteArtifactReceipt,
  assertRemoteSshPackIsolation,
  createRemoteAcquisitionRootReceipt,
  downloadPinnedRemoteArtifact,
  PINNED_REMOTE_SSH_EXTENSION_ID,
  PINNED_REMOTE_SSH_VERSION,
  PINNED_DROPBEAR_VERSION,
  PINNED_REMOTE_VSCODE_COMMIT,
  PINNED_REMOTE_VSCODE_VERSION,
  PINNED_REMOTE_WORKSPACE_TARGETS,
  validatePinnedRemoteTarget,
  validateTarManifest
} from "./remote-workspace-acquisition.mjs";

test("Remote SSH acceptance pins one exact official VS Code artifact chain", () => {
  assert.equal(PINNED_REMOTE_VSCODE_VERSION, "1.130.0");
  assert.equal(PINNED_REMOTE_VSCODE_COMMIT, "1b6a188127eeaf9194f945eb6eb89a657e93c54c");
  assert.equal(PINNED_REMOTE_SSH_EXTENSION_ID, "ms-vscode-remote.remote-ssh");
  assert.equal(PINNED_REMOTE_SSH_VERSION, "0.124.0");
  assert.equal(PINNED_DROPBEAR_VERSION, "2025.89");
  assert.deepEqual(Object.keys(PINNED_REMOTE_WORKSPACE_TARGETS), [
    "vscode",
    "cli",
    "server",
    "remoteSsh",
    "dropbear",
    "tomcrypt",
    "tommath"
  ]);
  for (const target of Object.values(PINNED_REMOTE_WORKSPACE_TARGETS)) {
    assert.equal(validatePinnedRemoteTarget(target), target);
    assert.match(target.wireSha256, /^[0-9a-f]{64}$/u);
    assert.match(target.decodedSha256, /^[0-9a-f]{64}$/u);
  }
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.vscode.wireBytes, 356_926_919);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.cli.wireBytes, 12_192_722);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.server.wireBytes, 192_198_459);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.remoteSsh.wireBytes, 734_122);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.remoteSsh.decodedBytes, 742_378);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.dropbear.wireBytes, 178_902);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.tomcrypt.wireBytes, 396_060);
  assert.equal(PINNED_REMOTE_WORKSPACE_TARGETS.tommath.wireBytes, 56_448);
});

test("Remote artifact targets reject moving, credentialed, query, format, and redirect drift", () => {
  const target = { ...PINNED_REMOTE_WORKSPACE_TARGETS.cli };
  for (const mutation of [
    { url: "https://token@update.code.visualstudio.com/cli" },
    { url: `${target.url}?moving=1` },
    { redirectUrl: "https://example.invalid/cli.tar.gz" },
    { artifactName: "../cli.tar.gz" },
    { wireBytes: 0 },
    { wireSha256: "a".repeat(63) },
    { decodedSha256: "b".repeat(64) },
    { format: "zip" },
    { wireContentEncoding: "gzip" },
    { identity: "cursor" }
  ]) {
    assert.throws(() => validatePinnedRemoteTarget({ ...target, ...mutation }), /target is malformed/u);
  }
});

test("Remote acquisition root receipts retain identity while owned children change", () => {
  const root = privateRoot("openwrangler-remote-root-");
  try {
    assert.equal(root, realpathSync(root));
    const receipt = createRemoteAcquisitionRootReceipt(root);
    assert.doesNotThrow(() => assertRemoteAcquisitionRootReceipt(receipt));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote metadata and license reads reject in-place mutation and linked leaves", () => {
  const root = privateRoot("openwrangler-remote-bounded-read-");
  try {
    const metadata = join(root, "product.json");
    const linked = join(root, "linked.json");
    const original = '{"version":"1.130.0"}';
    const mutated = '{"version":"changed-after-open"}';
    assert.notEqual(Buffer.byteLength(original), Buffer.byteLength(mutated));
    writeFileSync(metadata, original);
    assert.throws(
      () =>
        readBoundedRegularFile(metadata, 1024, {
          containedBy: root,
          label: "Pinned VS Code metadata",
          afterOpenForTest() {
            writeFileSync(metadata, mutated);
          }
        }),
      /changed during its descriptor-bound read/u
    );
    writeFileSync(metadata, original);
    linkSync(metadata, linked);
    assert.throws(
      () =>
        readBoundedRegularFile(metadata, 1024, {
          containedBy: root,
          label: "Pinned VS Code runtime or license"
        }),
      /single-link regular file/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote artifact acquisition accepts only its exact redirect, length, and SHA receipt", async () => {
  const body = Buffer.from("pinned-remote-cli-body", "utf8");
  const target = testTarTarget(body);
  const root = privateRoot("openwrangler-remote-download-");
  try {
    const receipt = await downloadPinnedRemoteArtifact(target, createRemoteAcquisitionRootReceipt(root), {
      openResponse: responseSequence([
        response(302, Buffer.alloc(0), { location: target.redirectUrl }),
        response(200, body, { "content-length": String(body.length), "content-encoding": "identity" })
      ]),
      timeoutMs: 1_000
    });
    assert.equal(receipt.sha256, target.decodedSha256);
    assert.deepEqual(readFileSync(receipt.path), body);
    await assertPinnedRemoteArtifactReceipt(receipt);
    appendFileSync(receipt.path, "changed");
    await assert.rejects(assertPinnedRemoteArtifactReceipt(receipt), /receipt changed before use/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote artifact revalidation rejects in-place mutation after its descriptor opens", async () => {
  const body = Buffer.from("pinned-remote-cli-body", "utf8");
  const target = testTarTarget(body);
  const root = privateRoot("openwrangler-remote-hash-swap-");
  try {
    const receipt = await downloadPinnedRemoteArtifact(target, createRemoteAcquisitionRootReceipt(root), {
      openResponse: responseSequence([
        response(302, Buffer.alloc(0), { location: target.redirectUrl }),
        response(200, body, { "content-length": String(body.length), "content-encoding": "identity" })
      ]),
      timeoutMs: 1_000
    });
    await assert.rejects(
      assertPinnedRemoteArtifactReceipt(receipt, {
        afterHashOpen: () => writeFileSync(receipt.path, Buffer.alloc(body.length, 0x78), { mode: 0o600 })
      }),
      /changed while hashing/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Remote artifact acquisition rejects redirect, length, hash, and response drift without publishing", async () => {
  const expected = Buffer.from("expected-remote-body", "utf8");
  const target = testTarTarget(expected);
  const cases = [
    [
      "redirect",
      [
        response(302, Buffer.alloc(0), { location: "https://vscode.download.prss.microsoft.com/wrong" }),
        response(200, expected)
      ]
    ],
    [
      "length",
      [
        response(302, Buffer.alloc(0), { location: target.redirectUrl }),
        response(200, expected, { "content-length": String(expected.length + 1), "content-encoding": "identity" })
      ]
    ],
    [
      "hash",
      [
        response(302, Buffer.alloc(0), { location: target.redirectUrl }),
        response(200, Buffer.from("altered-remote!!"), {
          "content-length": String(expected.length),
          "content-encoding": "identity"
        })
      ]
    ],
    [
      "status",
      [
        response(302, Buffer.alloc(0), { location: target.redirectUrl }),
        response(503, expected, { "content-length": String(expected.length), "content-encoding": "identity" })
      ]
    ]
  ];
  for (const [label, responses] of cases) {
    const root = privateRoot(`openwrangler-remote-${label}-`);
    try {
      await assert.rejects(
        downloadPinnedRemoteArtifact(target, createRemoteAcquisitionRootReceipt(root), {
          openResponse: responseSequence(responses),
          timeoutMs: 1_000
        }),
        /redirect target drifted|unexpected response|exact wire receipt/u
      );
      assert.equal(existsSync(join(root, target.artifactName)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("Marketplace wire gzip must decode to the exact pinned VSIX receipt", async () => {
  const decoded = Buffer.from("bounded-vsix-fixture", "utf8");
  const wire = gzipSync(decoded, { level: 9, mtime: 0 });
  const target = {
    ...PINNED_REMOTE_WORKSPACE_TARGETS.remoteSsh,
    artifactName: "remote-ssh-test.vsix",
    wireBytes: wire.length,
    wireSha256: sha256(wire),
    decodedBytes: decoded.length,
    decodedSha256: sha256(decoded)
  };
  const root = privateRoot("openwrangler-remote-gzip-");
  try {
    const receipt = await downloadPinnedRemoteArtifact(target, createRemoteAcquisitionRootReceipt(root), {
      openResponse: responseSequence([
        response(200, wire, {
          "content-length": String(wire.length),
          "content-encoding": "gzip"
        })
      ]),
      timeoutMs: 1_000
    });
    assert.deepEqual(readFileSync(receipt.path), decoded);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tar manifest validation rejects links, traversal, absolute paths, duplicates, and file descendants", () => {
  assert.deepEqual(
    validateTarManifest(
      [
        { name: "root", type: "directory" },
        { name: "root/bin", type: "directory" },
        { name: "root/bin/code", type: "file" }
      ],
      { archiveRoot: "root" }
    ),
    { entries: 3 }
  );
  for (const entries of [
    [{ name: "root/link", type: "symlink" }],
    [{ name: "root/../escape", type: "file" }],
    [{ name: "/root/file", type: "file" }],
    [
      { name: "root/file", type: "file" },
      { name: "root/file", type: "file" }
    ],
    [
      { name: "root/file", type: "file" },
      { name: "root/file/child", type: "file" }
    ],
    [{ name: "other/file", type: "file" }],
    [{ name: "root\\file", type: "file" }]
  ]) {
    assert.throws(() => validateTarManifest(entries, { archiveRoot: "root" }), /tar archive/u);
  }
});

test("Remote SSH installation must suppress its exact optional dependency pack", () => {
  const packageJson = {
    name: "remote-ssh",
    publisher: "ms-vscode-remote",
    version: PINNED_REMOTE_SSH_VERSION,
    engines: { vscode: "^1.107.0" },
    extensionKind: ["ui"],
    extensionPack: ["ms-vscode-remote.remote-ssh-edit", "ms-vscode.remote-explorer"]
  };
  assert.deepEqual(assertRemoteSshPackIsolation(packageJson), {
    installArguments: ["--do-not-include-pack-dependencies"],
    optionalPack: ["ms-vscode-remote.remote-ssh-edit", "ms-vscode.remote-explorer"]
  });
  assert.throws(
    () =>
      assertRemoteSshPackIsolation({
        ...packageJson,
        extensionPack: [...packageJson.extensionPack, "moving.extension"]
      }),
    /extension pack drifted/u
  );
  assert.throws(
    () => assertRemoteSshPackIsolation({ ...packageJson, extensionKind: ["workspace"] }),
    /execution placement drifted/u
  );
});

function privateRoot(prefix) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  chmodSync(root, 0o700);
  return root;
}

function testTarTarget(body) {
  return {
    ...PINNED_REMOTE_WORKSPACE_TARGETS.cli,
    artifactName: "vscode-cli-test.tar.gz",
    wireBytes: body.length,
    wireSha256: sha256(body),
    decodedBytes: body.length,
    decodedSha256: sha256(body)
  };
}

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      ...headers,
      ...(statusCode === 200 && headers["content-length"] === undefined
        ? { "content-length": String(body.length), "content-encoding": "identity" }
        : {})
    },
    body: Readable.from([body])
  };
}

function responseSequence(responses) {
  let index = 0;
  return async () => {
    const next = responses[index];
    index += 1;
    if (!next) throw new Error("Unexpected extra acquisition request.");
    return next;
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
