import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LOCK_PROTOCOL,
  LOCK_PURPOSE,
  LOCK_ROOTS,
  SNAPSHOT_DATE,
  canonicalLockBytes,
  readLock,
  sha256,
  validateLock
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
