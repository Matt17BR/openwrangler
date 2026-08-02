import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  constants,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DURABLE_JSON_PUBLICATION_FAULT_POINTS,
  DURABLE_JSON_RECOVERY_FAULT_POINTS,
  canonicalDurableJson,
  digestDurableJsonValue,
  publishDurableStudyJsonExclusive,
  recoverDurableStudyJsonPublication
} from "./durable-study-json.mjs";

const STUDY_VALUE = Object.freeze({
  captureId: "8df442f4-0207-4c9f-a6d2-eab877dd9f78",
  result: Object.freeze({ supported: false, trial: 7 })
});

function withTemporaryDirectory(callback) {
  const directory = mkdtempSync(join(tmpdir(), "ow-durable-json-"));
  try {
    callback(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function exists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function identity(path) {
  const metadata = lstatSync(path, { bigint: true });
  return {
    device: metadata.dev,
    inode: metadata.ino,
    links: metadata.nlink,
    mode: metadata.mode & 0o777n
  };
}

function assertSameInode(leftPath, rightPath, expectedLinks) {
  const left = identity(leftPath);
  const right = identity(rightPath);
  assert.equal(left.device, right.device);
  assert.equal(left.inode, right.inode);
  assert.equal(left.links, BigInt(expectedLinks));
  assert.equal(right.links, BigInt(expectedLinks));
}

function tokenFor(index) {
  return index.toString(16).padStart(32, "0");
}

function temporaryPath(directory, targetName, token) {
  return join(directory, `.${targetName}.ow-study-publish-${token}.tmp`);
}

function injectAt(expectedPoint) {
  return (point) => {
    if (point === expectedPoint) {
      throw new Error(`injected:${expectedPoint}`);
    }
  };
}

test("exclusive publication produces one private canonical artifact and never replaces it", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, "study-result.json");
    const receipt = publishDurableStudyJsonExclusive(target, STUDY_VALUE, {
      tokenFactory: () => tokenFor(1)
    });

    assert.deepEqual(receipt, {
      protocol: "openwrangler-durable-study-json-publication-v1",
      status: "published",
      sha256: digestDurableJsonValue(STUDY_VALUE),
      bytes: Buffer.byteLength(canonicalDurableJson(STUDY_VALUE)),
      identity: identityReceipt(target)
    });
    assert.equal(readFileSync(target, "utf8"), canonicalDurableJson(STUDY_VALUE));
    assert.equal(identity(target).links, 1n);
    assert.equal(identity(target).mode, 0o600n);
    assert.deepEqual(readdirSync(directory), ["study-result.json"]);

    const original = readFileSync(target);
    const originalIdentity = identity(target);
    assert.throws(
      () =>
        publishDurableStudyJsonExclusive(
          target,
          { replacement: true },
          {
            tokenFactory: () => tokenFor(2)
          }
        ),
      /already exists/u
    );
    assert.deepEqual(readFileSync(target), original);
    assert.deepEqual(identity(target), originalIdentity);

    assert.deepEqual(recoverDurableStudyJsonPublication(target, receipt.sha256), {
      protocol: "openwrangler-durable-study-json-recovery-v1",
      status: "complete",
      recovered: false,
      sha256: receipt.sha256,
      bytes: receipt.bytes,
      identity: receipt.identity
    });
  });
});

test("publication is Linux-only and rejects before creating a directory entry", () => {
  withTemporaryDirectory((directory) => {
    const target = join(directory, "study-result.json");
    assert.throws(
      () => publishDurableStudyJsonExclusive(target, STUDY_VALUE, { platform: "darwin" }),
      /requires Linux/u
    );
    assert.deepEqual(readdirSync(directory), []);
    assert.throws(
      () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE), { platform: "win32" }),
      /requires Linux/u
    );
    assert.deepEqual(readdirSync(directory), []);
  });
});

test("publication and recovery require an exclusively controlled mode-0700 parent", () => {
  for (const mode of [0o755, 0o770]) {
    withTemporaryDirectory((directory) => {
      const target = join(directory, "study-result.json");
      chmodSync(directory, mode);
      assert.throws(() => publishDurableStudyJsonExclusive(target, STUDY_VALUE), /owned mode-0700 directory/u);
      assert.deepEqual(readdirSync(directory), []);
      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /owned mode-0700 directory/u
      );
      assert.deepEqual(readdirSync(directory), []);
    });
  }
});

test("parent mode drift after opening fails closed before the target link", () => {
  withTemporaryDirectory((directory) => {
    const targetName = "study-result.json";
    const target = join(directory, targetName);
    const token = tokenFor(9);
    const temporary = temporaryPath(directory, targetName, token);
    assert.throws(
      () =>
        publishDurableStudyJsonExclusive(target, STUDY_VALUE, {
          faultInjector: (point) => {
            if (point === "temporary-closed") {
              chmodSync(directory, 0o755);
            }
          },
          tokenFactory: () => token
        }),
      /exact cleanup did not fully settle/u
    );
    assert.equal(exists(target), false);
    assert.equal(exists(temporary), true);
    assert.equal(identity(temporary).links, 1n);

    chmodSync(directory, 0o700);
    assert.equal(recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)).status, "absent");
    assert.equal(exists(temporary), true);
  });
});

test("a borrowed parent lease anchors publication and recovery to one directory generation", () => {
  withTemporaryDirectory((directory) => {
    const ledger = join(directory, "ledger");
    const displaced = join(directory, "ledger-displaced");
    mkdirSync(ledger, { mode: 0o700 });
    const descriptor = openSync(ledger, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const parentLease = { descriptor, path: ledger };
    const target = join(ledger, "study-result.json");
    try {
      const published = publishDurableStudyJsonExclusive(target, STUDY_VALUE, { parentLease });
      assert.equal(published.status, "published");
      assert.equal(recoverDurableStudyJsonPublication(target, published.sha256, { parentLease }).status, "complete");

      renameSync(ledger, displaced);
      mkdirSync(ledger, { mode: 0o700 });
      assert.throws(
        () => recoverDurableStudyJsonPublication(target, published.sha256, { parentLease }),
        /borrowed durable JSON parent no longer matches/u
      );
      assert.deepEqual(readdirSync(ledger), []);
      assert.deepEqual(readdirSync(displaced), ["study-result.json"]);
    } finally {
      closeSync(descriptor);
    }
  });
});

test("every publication boundary has a deterministic crash state that recovery handles conservatively", async (t) => {
  const prelink = new Set(["temporary-opened", "temporary-written", "temporary-file-synced", "temporary-closed"]);
  const linked = new Set(["target-linked", "link-directory-synced"]);

  for (const [index, point] of DURABLE_JSON_PUBLICATION_FAULT_POINTS.entries()) {
    await t.test(point, () => {
      withTemporaryDirectory((directory) => {
        const targetName = "study-result.json";
        const target = join(directory, targetName);
        const token = tokenFor(index + 10);
        const temporary = temporaryPath(directory, targetName, token);
        const expectedSha256 = digestDurableJsonValue(STUDY_VALUE);

        assert.throws(
          () =>
            publishDurableStudyJsonExclusive(target, STUDY_VALUE, {
              faultInjector: injectAt(point),
              tokenFactory: () => token
            }),
          new RegExp(`injected:${point}`, "u")
        );

        if (prelink.has(point)) {
          assert.equal(exists(target), false);
          assert.equal(exists(temporary), true);
          assert.equal(identity(temporary).links, 1n);
          const orphanIdentity = identity(temporary);
          assert.deepEqual(recoverDurableStudyJsonPublication(target, expectedSha256), {
            protocol: "openwrangler-durable-study-json-recovery-v1",
            status: "absent",
            recovered: false
          });
          assert.deepEqual(identity(temporary), orphanIdentity);
          return;
        }

        if (linked.has(point)) {
          assertSameInode(target, temporary, 2);
          const recovered = recoverDurableStudyJsonPublication(target, expectedSha256);
          assert.equal(recovered.status, "recovered");
          assert.equal(recovered.recovered, true);
          assert.equal(exists(temporary), false);
        } else {
          assert.equal(exists(temporary), false);
          const recovered = recoverDurableStudyJsonPublication(target, expectedSha256);
          assert.equal(recovered.status, "complete");
          assert.equal(recovered.recovered, false);
        }
        assert.equal(readFileSync(target, "utf8"), canonicalDurableJson(STUDY_VALUE));
        assert.equal(identity(target).links, 1n);
      });
    });
  }
});

test("every recovery boundary is safely repeatable after an injected crash", async (t) => {
  const linked = new Set(["recovery-target-validated", "recovery-link-directory-synced"]);

  for (const [index, point] of DURABLE_JSON_RECOVERY_FAULT_POINTS.entries()) {
    await t.test(point, () => {
      withTemporaryDirectory((directory) => {
        const targetName = "study-result.json";
        const target = join(directory, targetName);
        const token = tokenFor(index + 100);
        const temporary = temporaryPath(directory, targetName, token);
        const expectedSha256 = digestDurableJsonValue(STUDY_VALUE);
        if (point === "recovery-complete-directory-synced") {
          publishDurableStudyJsonExclusive(target, STUDY_VALUE, { tokenFactory: () => token });
          assert.equal(exists(temporary), false);
          assert.throws(
            () => recoverDurableStudyJsonPublication(target, expectedSha256, { faultInjector: injectAt(point) }),
            new RegExp(`injected:${point}`, "u")
          );
          assert.equal(recoverDurableStudyJsonPublication(target, expectedSha256).status, "complete");
          assert.equal(identity(target).links, 1n);
          assert.equal(readFileSync(target, "utf8"), canonicalDurableJson(STUDY_VALUE));
          return;
        }
        assert.throws(
          () =>
            publishDurableStudyJsonExclusive(target, STUDY_VALUE, {
              faultInjector: injectAt("target-linked"),
              tokenFactory: () => token
            }),
          /injected:target-linked/u
        );
        assertSameInode(target, temporary, 2);

        assert.throws(
          () => recoverDurableStudyJsonPublication(target, expectedSha256, { faultInjector: injectAt(point) }),
          new RegExp(`injected:${point}`, "u")
        );

        if (linked.has(point)) {
          assertSameInode(target, temporary, 2);
          assert.equal(recoverDurableStudyJsonPublication(target, expectedSha256).status, "recovered");
        } else {
          assert.equal(exists(temporary), false);
          assert.equal(recoverDurableStudyJsonPublication(target, expectedSha256).status, "complete");
        }
        assert.equal(identity(target).links, 1n);
        assert.equal(readFileSync(target, "utf8"), canonicalDurableJson(STUDY_VALUE));
      });
    });
  }
});

test("recovery recognizes only one exact well-named same-inode two-link temporary", async (t) => {
  await t.test("an absent target does not authorize orphan cleanup", () => {
    withTemporaryDirectory((directory) => {
      const targetName = "study-result.json";
      const orphan = temporaryPath(directory, targetName, tokenFor(200));
      writeFileSync(orphan, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      const orphanIdentity = identity(orphan);
      assert.equal(
        recoverDurableStudyJsonPublication(join(directory, targetName), digestDurableJsonValue(STUDY_VALUE)).status,
        "absent"
      );
      assert.deepEqual(identity(orphan), orphanIdentity);
    });
  });

  await t.test("a different second hard link and a decoy exact name are ambiguous", () => {
    withTemporaryDirectory((directory) => {
      const targetName = "study-result.json";
      const target = join(directory, targetName);
      const otherLink = join(directory, "unrelated-hard-link.json");
      const decoy = temporaryPath(directory, targetName, tokenFor(201));
      writeFileSync(target, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      linkSync(target, otherLink);
      writeFileSync(decoy, "{}\n", { mode: 0o600 });
      const before = new Map(
        [target, otherLink, decoy].map((path) => [path, { bytes: readFileSync(path), identity: identity(path) }])
      );

      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /no unique exact crash-recovery temporary/u
      );
      for (const [path, expected] of before) {
        assert.deepEqual(readFileSync(path), expected.bytes);
        assert.deepEqual(identity(path), expected.identity);
      }
    });
  });

  await t.test("three links remain ambiguous even when one has the exact temporary name", () => {
    withTemporaryDirectory((directory) => {
      const targetName = "study-result.json";
      const target = join(directory, targetName);
      const exact = temporaryPath(directory, targetName, tokenFor(202));
      const third = join(directory, "third-link.json");
      writeFileSync(target, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      linkSync(target, exact);
      linkSync(target, third);

      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /ambiguous link count/u
      );
      assertSameInode(target, exact, 3);
      assertSameInode(target, third, 3);
    });
  });

  await t.test("a non-exact temporary spelling is never recovered", () => {
    withTemporaryDirectory((directory) => {
      const targetName = "study-result.json";
      const target = join(directory, targetName);
      const nonExact = temporaryPath(directory, targetName, tokenFor(203).toUpperCase());
      writeFileSync(target, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      linkSync(target, nonExact);

      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /no unique exact crash-recovery temporary/u
      );
      assertSameInode(target, nonExact, 2);
    });
  });
});

test("invalid or ambiguous targets are never deleted, replaced, or repaired", async (t) => {
  await t.test("wrong digest", () => {
    withTemporaryDirectory((directory) => {
      const target = join(directory, "study-result.json");
      writeFileSync(target, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      const before = { bytes: readFileSync(target), identity: identity(target) };
      assert.throws(() => recoverDurableStudyJsonPublication(target, "f".repeat(64)), /expected digest/u);
      assert.deepEqual(readFileSync(target), before.bytes);
      assert.deepEqual(identity(target), before.identity);
    });
  });

  await t.test("public file mode", () => {
    withTemporaryDirectory((directory) => {
      const target = join(directory, "study-result.json");
      writeFileSync(target, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      chmodSync(target, 0o644);
      const before = { bytes: readFileSync(target), identity: identity(target) };
      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /private, owned regular file/u
      );
      assert.deepEqual(readFileSync(target), before.bytes);
      assert.deepEqual(identity(target), before.identity);
    });
  });

  await t.test("symbolic link", () => {
    withTemporaryDirectory((directory) => {
      const referent = join(directory, "referent.json");
      const target = join(directory, "study-result.json");
      writeFileSync(referent, canonicalDurableJson(STUDY_VALUE), { mode: 0o600 });
      symlinkSync(referent, target);
      const before = { referent: readFileSync(referent), target: identity(target) };
      assert.throws(
        () => recoverDurableStudyJsonPublication(target, digestDurableJsonValue(STUDY_VALUE)),
        /Could not read/u
      );
      assert.equal(lstatSync(target).isSymbolicLink(), true);
      assert.deepEqual(identity(target), before.target);
      assert.deepEqual(readFileSync(referent), before.referent);
    });
  });
});

test("a colliding pre-existing temporary is preserved", () => {
  withTemporaryDirectory((directory) => {
    const targetName = "study-result.json";
    const target = join(directory, targetName);
    const token = tokenFor(300);
    const temporary = temporaryPath(directory, targetName, token);
    writeFileSync(temporary, "unrelated\n", { mode: 0o600 });
    const before = { bytes: readFileSync(temporary), identity: identity(temporary) };

    assert.throws(
      () => publishDurableStudyJsonExclusive(target, STUDY_VALUE, { tokenFactory: () => token }),
      /EEXIST/u
    );
    assert.equal(exists(target), false);
    assert.deepEqual(readFileSync(temporary), before.bytes);
    assert.deepEqual(identity(temporary), before.identity);
  });
});

test("canonical durable JSON rejects values whose serialization could be lossy or active", () => {
  assert.equal(
    canonicalDurableJson({ z: -0, a: [true, null] }),
    '{\n  "a": [\n    true,\n    null\n  ],\n  "z": 0\n}\n'
  );
  assert.throws(() => canonicalDurableJson({ value: Number.NaN }), /non-finite/u);
  assert.throws(() => canonicalDurableJson({ value: 1n }), /non-JSON/u);

  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => canonicalDurableJson(cycle), /cycle/u);

  const sparseWithDecoy = ["first", "deleted"];
  delete sparseWithDecoy[1];
  sparseWithDecoy.extra = "not an array element";
  assert.throws(() => canonicalDurableJson(sparseWithDecoy), /sparse array/u);

  const active = {};
  Object.defineProperty(active, "value", { enumerable: true, get: () => "side effect" });
  assert.throws(() => canonicalDurableJson(active), /enumerable data field/u);

  const symbolKey = { ordinary: true, [Symbol("hidden")]: true };
  assert.throws(() => canonicalDurableJson(symbolKey), /symbol-keyed/u);
});

function identityReceipt(path) {
  const metadata = lstatSync(path, { bigint: true });
  return { device: metadata.dev.toString(), inode: metadata.ino.toString() };
}
