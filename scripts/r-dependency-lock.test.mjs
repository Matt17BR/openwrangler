import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LOCK_PROTOCOL,
  LOCK_PURPOSE,
  LOCK_ROOTS,
  SNAPSHOT_DATE,
  canonicalLockBytes,
  installFromArchiveCache,
  readOwnedRegularFile,
  readLock,
  sha256,
  treeDigest,
  validateLock,
  verifyArchiveCache
} from "./r-dependency-lock.mjs";

function packageEntry(name, rMinor = "4.5") {
  const repositorySnapshotUrl = `https://packagemanager.posit.co/cran/${SNAPSHOT_DATE}/bin/linux/noble-x86_64/${rMinor}/src/contrib`;
  return {
    name,
    version: "1.2.3",
    direct: true,
    needsCompilation: false,
    license: "MIT",
    dependencies: { depends: [], imports: [], linkingTo: [] },
    source: {
      kind: "binary",
      repositorySnapshotUrl,
      url: `${repositorySnapshotUrl}/${name}_1.2.3.tar.gz`,
      bytes: 1234,
      sha256: sha256(name)
    }
  };
}

function validLock(rMinor = "4.5") {
  const repositorySnapshotUrl = `https://packagemanager.posit.co/cran/${SNAPSHOT_DATE}/bin/linux/noble-x86_64/${rMinor}/src/contrib`;
  return {
    protocol: LOCK_PROTOCOL,
    purpose: LOCK_PURPOSE,
    qualification: {
      rMinor,
      generatedWithRVersion: `${rMinor}.3`,
      os: "linux",
      distribution: "ubuntu",
      distributionVersion: "24.04",
      architecture: "x86_64",
      rPlatform: "x86_64-pc-linux-gnu"
    },
    resolver: {
      name: "openwrangler-r-dependency-lock",
      exactVersion: "1",
      repositorySnapshotUrl,
      snapshotDate: SNAPSHOT_DATE
    },
    roots: [...LOCK_ROOTS],
    packages: [...LOCK_ROOTS].sort().map((name) => packageEntry(name, rMinor)),
    systemRequirements: { packages: ["libx11-dev"] }
  };
}

function clone(value) {
  return structuredClone(value);
}

function cacheLock() {
  const lock = validLock();
  for (const entry of lock.packages) {
    const bytes = Buffer.from(`archive:${entry.name}`, "utf8");
    entry.source.bytes = bytes.length;
    entry.source.sha256 = sha256(bytes);
  }
  validateLock(lock);
  return lock;
}

function writeArchiveCache(directory, lock) {
  mkdirSync(directory, { mode: 0o700 });
  for (const entry of lock.packages) {
    writeFileSync(
      join(directory, `${entry.name}_${entry.version}.tar.gz`),
      Buffer.from(`archive:${entry.name}`, "utf8"),
      {
        mode: 0o600
      }
    );
  }
}

function fakeInstalledReceipt(lockRecord) {
  const receipt = {
    protocol: "openwrangler-native-r-installed-library-v1",
    lockSha256: lockRecord.digest,
    rVersion: lockRecord.lock.qualification.generatedWithRVersion,
    rPlatform: lockRecord.lock.qualification.rPlatform,
    packageCount: lockRecord.lock.packages.length,
    packageSetSha256: sha256("packages"),
    treeSha256: sha256("tree"),
    archiveCount: lockRecord.lock.packages.length,
    archiveBytes: lockRecord.lock.packages.reduce((sum, entry) => sum + entry.source.bytes, 0),
    archiveSetSha256: sha256("archives")
  };
  return { receipt, bytes: canonicalLockBytes(receipt), runtime: { command: "/fake/Rscript" } };
}

function fileOperations(overrides = {}) {
  return {
    closeSync,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    readdirSync,
    realpathSync,
    ...overrides
  };
}

test("strict canonical locks bind the exact qualification, roots, archives, and filename", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-lock-test-"));
  try {
    const lock = validLock();
    const path = join(directory, "ubuntu-24.04-x86_64-r-4.5.lock.json");
    const bytes = canonicalLockBytes(lock);
    writeFileSync(path, bytes);
    assert.equal(readLock(path).digest, sha256(bytes));
    assert.equal(validateLock(lock).packageCount, 8);

    writeFileSync(path, bytes.trimEnd());
    assert.throws(() => readLock(path), /not canonical JSON/u);

    writeFileSync(path, bytes.replace('"protocol":', '"protocol": "duplicate",\n  "protocol":'));
    assert.throws(() => readLock(path), /duplicate keys/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lock validation rejects mutable URLs, unknown fields, unsafe system commands, and source drift", () => {
  const mutable = clone(validLock());
  mutable.resolver.repositorySnapshotUrl = mutable.resolver.repositorySnapshotUrl.replace(SNAPSHOT_DATE, "latest");
  assert.throws(() => validateLock(mutable), /exact dated/u);

  const unknown = clone(validLock());
  unknown.packages[0].unexpected = true;
  assert.throws(() => validateLock(unknown), /keys must be exactly/u);

  const command = clone(validLock());
  command.systemRequirements.packages = ["apt-get install libx11-dev"];
  assert.throws(() => validateLock(command), /invalid value/u);

  const drift = clone(validLock());
  drift.packages[0].source.url = drift.packages[0].source.url.replace("1.2.3", "1.2.4");
  assert.throws(() => validateLock(drift), /exact dated/u);
});

test("lock validation rejects cycles, unreachable extras, and inconsistent direct ownership", () => {
  const cycle = clone(validLock());
  cycle.packages.find((entry) => entry.name === "bit64").dependencies.imports = ["collapse"];
  cycle.packages.find((entry) => entry.name === "collapse").dependencies.imports = ["bit64"];
  assert.throws(() => validateLock(cycle), /cycle/u);

  const unreachable = clone(validLock());
  const extra = packageEntry("unused");
  extra.direct = false;
  unreachable.packages.push(extra);
  unreachable.packages.sort((left, right) => left.name.localeCompare(right.name));
  assert.throws(() => validateLock(unreachable), /unreachable/u);

  const ownership = clone(validLock());
  ownership.packages[0].direct = false;
  assert.throws(() => validateLock(ownership), /inconsistent/u);
});

test("lock validation accepts fixed base and recommended R dependencies but no unlocked package", () => {
  const fixed = clone(validLock());
  fixed.packages[0].dependencies.imports = ["methods", "stats"];
  assert.doesNotThrow(() => validateLock(fixed));

  const missing = clone(validLock());
  missing.packages[0].dependencies.imports = ["ambientPackage"];
  assert.throws(() => validateLock(missing), /unlocked hard dependency/u);
});

test("archive cache authenticates every exact lock-pinned descriptor before installation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-cache-test-"));
  try {
    const lock = cacheLock();
    const lockRecord = { lock, bytes: Buffer.from(canonicalLockBytes(lock)), digest: sha256(canonicalLockBytes(lock)) };
    const archives = join(directory, "archives");
    const library = join(directory, "library");
    const receipt = join(directory, "receipt.json");
    writeArchiveCache(archives, lock);
    assert.equal(verifyArchiveCache({ lockRecord, archives }).paths.size, lock.packages.length);

    const installed = [];
    const verified = await installFromArchiveCache({
      lockRecord,
      rscript: "/fake/Rscript",
      library,
      archives,
      receipt,
      cacheHit: true,
      installArchive: ({ entry }) => installed.push(entry.name),
      verifyLibrary: () => fakeInstalledReceipt(lockRecord)
    });
    assert.deepEqual(
      installed,
      lock.packages.map((entry) => entry.name)
    );
    assert.equal(readFileSync(receipt, "utf8"), verified.bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the final tampered archive fails before any install or namespace verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-cache-tamper-"));
  try {
    const lock = cacheLock();
    const lockRecord = { lock, bytes: Buffer.from(canonicalLockBytes(lock)), digest: sha256(canonicalLockBytes(lock)) };
    const archives = join(directory, "archives");
    const library = join(directory, "library");
    const receipt = join(directory, "receipt.json");
    writeArchiveCache(archives, lock);
    const last = lock.packages.at(-1);
    writeFileSync(join(archives, `${last.name}_${last.version}.tar.gz`), "tampered", { mode: 0o600 });
    let installs = 0;
    let namespaceVerifications = 0;
    await assert.rejects(
      installFromArchiveCache({
        lockRecord,
        rscript: "/fake/Rscript",
        library,
        archives,
        receipt,
        cacheHit: true,
        installArchive: () => {
          installs += 1;
        },
        verifyLibrary: () => {
          namespaceVerifications += 1;
          return fakeInstalledReceipt(lockRecord);
        }
      }),
      /bounded singly linked regular file|identity or digest is invalid/u
    );
    assert.equal(installs, 0);
    assert.equal(namespaceVerifications, 0);
    assert.equal(existsSync(library), false);
    assert.equal(existsSync(receipt), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("owned files reject deterministic replacement after open and during descriptor read", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-owned-file-race-"));
  try {
    const path = join(directory, "owned.bin");
    const displaced = join(directory, "displaced.bin");
    const trusted = Buffer.from("trusted archive", "utf8");
    const replacement = Buffer.from("replacement bytes", "utf8");
    writeFileSync(path, trusted, { mode: 0o600 });

    assert.throws(
      () =>
        readOwnedRegularFile(path, "after-open test file", {
          expectedBytes: trusted.length,
          expectedSha256: sha256(trusted),
          root: directory,
          operations: fileOperations({
            openSync(candidate, flags) {
              const descriptor = openSync(candidate, flags);
              renameSync(path, displaced);
              writeFileSync(path, replacement, { mode: 0o600 });
              return descriptor;
            }
          })
        }),
      /descriptor does not match its named path/u
    );

    unlinkSync(path);
    renameSync(displaced, path);
    assert.throws(
      () =>
        readOwnedRegularFile(path, "during-read test file", {
          expectedBytes: trusted.length,
          expectedSha256: sha256(trusted),
          root: directory,
          operations: fileOperations({
            readFileSync(descriptor) {
              const bytes = readFileSync(descriptor);
              renameSync(path, displaced);
              writeFileSync(path, replacement, { mode: 0o600 });
              return bytes;
            }
          })
        }),
      /identity changed during its descriptor read/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive authentication rejects symlinks and hard links before install or namespace verification", async () => {
  for (const linkKind of ["symbolic", "hard"]) {
    const directory = mkdtempSync(join(tmpdir(), `ow-r-cache-${linkKind}-link-`));
    try {
      const lock = cacheLock();
      const lockRecord = {
        lock,
        bytes: Buffer.from(canonicalLockBytes(lock)),
        digest: sha256(canonicalLockBytes(lock))
      };
      const archives = join(directory, "archives");
      const library = join(directory, "library");
      const receipt = join(directory, "receipt.json");
      writeArchiveCache(archives, lock);
      const entry = lock.packages[0];
      const archive = join(archives, `${entry.name}_${entry.version}.tar.gz`);
      const target = join(directory, `${linkKind}-target.tar.gz`);
      renameSync(archive, target);
      if (linkKind === "symbolic") symlinkSync(target, archive);
      else linkSync(target, archive);
      let installs = 0;
      let namespaceVerifications = 0;

      await assert.rejects(
        installFromArchiveCache({
          lockRecord,
          rscript: "/fake/Rscript",
          library,
          archives,
          receipt,
          cacheHit: true,
          installArchive: () => {
            installs += 1;
          },
          verifyLibrary: () => {
            namespaceVerifications += 1;
            return fakeInstalledReceipt(lockRecord);
          }
        }),
        linkKind === "symbolic" ? /ELOOP|symbolic link/u : /singly linked regular file/u
      );
      assert.equal(installs, 0);
      assert.equal(namespaceVerifications, 0);
      assert.equal(existsSync(library), false);
      assert.equal(existsSync(receipt), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("installed tree hashing accepts bounded empty files and rejects descriptor-read replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-tree-digest-"));
  try {
    const empty = join(directory, "empty");
    const filled = join(directory, "filled");
    writeFileSync(empty, Buffer.alloc(0), { mode: 0o600 });
    writeFileSync(filled, "trusted installed bytes", { mode: 0o600 });
    const emptyVerified = readOwnedRegularFile(empty, "empty expected installed file", {
      minimumBytes: 0,
      maximumBytes: 0,
      root: directory
    });
    const filledVerified = readOwnedRegularFile(filled, "filled expected installed file", {
      maximumBytes: 1024,
      root: directory
    });
    const expected = sha256(
      [
        `empty\0file\0${emptyVerified.snapshot.mode & 0o777}\0${emptyVerified.snapshot.size}\0${sha256(emptyVerified.bytes)}`,
        `filled\0file\0${filledVerified.snapshot.mode & 0o777}\0${filledVerified.snapshot.size}\0${sha256(filledVerified.bytes)}`
      ].join("\n") + "\n"
    );
    assert.equal(treeDigest(directory), expected);

    const displaced = join(directory, "filled.displaced");
    let replaced = false;
    assert.throws(
      () =>
        treeDigest(directory, {
          operations: fileOperations({
            readFileSync(descriptor) {
              const bytes = readFileSync(descriptor);
              if (!replaced && bytes.length > 0) {
                replaced = true;
                renameSync(filled, displaced);
                writeFileSync(filled, "replacement installed bytes", { mode: 0o600 });
              }
              return bytes;
            }
          })
        }),
      /identity changed during its descriptor read/u
    );
    assert.equal(replaced, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a colocated forged library and receipt can never act as a cache hit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-cache-forged-"));
  try {
    const lock = cacheLock();
    const lockRecord = { lock, bytes: Buffer.from(canonicalLockBytes(lock)), digest: sha256(canonicalLockBytes(lock)) };
    const archives = join(directory, "archives");
    const library = join(directory, "library");
    const receipt = join(directory, "receipt.json");
    writeArchiveCache(archives, lock);
    mkdirSync(library, { mode: 0o700 });
    writeFileSync(join(library, "forged-package"), "forged", { mode: 0o600 });
    writeFileSync(receipt, "forged receipt", { mode: 0o600 });
    let installs = 0;
    let namespaceVerifications = 0;
    await assert.rejects(
      installFromArchiveCache({
        lockRecord,
        rscript: "/fake/Rscript",
        library,
        archives,
        receipt,
        cacheHit: true,
        installArchive: () => {
          installs += 1;
        },
        verifyLibrary: () => {
          namespaceVerifications += 1;
          return fakeInstalledReceipt(lockRecord);
        }
      }),
      /empty regular directory/u
    );
    assert.equal(installs, 0);
    assert.equal(namespaceVerifications, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive installation cannot bypass final fresh-library verification", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ow-r-cache-bypass-"));
  try {
    const lock = cacheLock();
    const lockRecord = { lock, bytes: Buffer.from(canonicalLockBytes(lock)), digest: sha256(canonicalLockBytes(lock)) };
    const archives = join(directory, "archives");
    const receipt = join(directory, "receipt.json");
    writeArchiveCache(archives, lock);
    let installs = 0;
    let verifications = 0;
    await assert.rejects(
      installFromArchiveCache({
        lockRecord,
        rscript: "/fake/Rscript",
        library: join(directory, "library"),
        archives,
        receipt,
        cacheHit: true,
        installArchive: () => {
          installs += 1;
        },
        verifyLibrary: () => {
          verifications += 1;
          throw new Error("fresh installed package set is missing");
        }
      }),
      /fresh installed package set is missing/u
    );
    assert.equal(installs, lock.packages.length);
    assert.equal(verifications, 1);
    assert.equal(existsSync(receipt), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
