import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareRepositoryLocalXvfb } from "./prepare-xvfb.mjs";

const LINUX_ONLY = { skip: process.platform !== "linux" };

function testFixture() {
  const root = mkdtempSync(join(tmpdir(), "openwrangler-xvfb-bootstrap-"));
  chmodSync(root, 0o700);
  const packageBytes = Buffer.from("pinned test package");
  const executableBytes = Buffer.alloc(96, 0x5a);
  executableBytes[0] = 0x7f;
  executableBytes.write("ELF", 1, "ascii");
  executableBytes[4] = 2;
  executableBytes[5] = 1;
  executableBytes.writeUInt16LE(62, 18);
  const record = {
    cacheKey: "ubuntu-99.99-amd64-xvfb-test",
    distribution: "ubuntu",
    distributionVersion: "99.99",
    nodeArchitecture: "x64",
    packageArchitecture: "amd64",
    packageVersion: "1:test",
    snapshot: "20260720T000000Z",
    url: "https://snapshot.ubuntu.com/ubuntu/20260720T000000Z/pool/universe/x/xorg-server/xvfb_test_amd64.deb",
    size: packageBytes.length,
    sha256: sha256(packageBytes),
    executableSize: executableBytes.length,
    executableSha256: sha256(executableBytes),
    requiredPackages: ["xserver-common"],
    exactPackageVersions: { "xserver-common": "1:test" },
    license: "MIT",
    source: "https://packages.ubuntu.com/test/xvfb"
  };
  return {
    root,
    cacheRoot: join(root, "cache"),
    packageBytes,
    executableBytes,
    manifest: { schemaVersion: 1, packages: { "ubuntu:99.99:x64": record } },
    osReleaseText: 'ID="ubuntu"\nVERSION_ID="99.99"\n'
  };
}

test("prepares one pinned repository-local Xvfb and reuses the validated cache", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  let downloads = 0;
  let extractions = 0;
  const options = {
    platform: "linux",
    architecture: "x64",
    osReleaseText: fixture.osReleaseText,
    manifest: fixture.manifest,
    cacheRoot: fixture.cacheRoot,
    queryPackage: async () => ({ status: "ii", version: "1:test" }),
    downloadPackage: async ({ destination }) => {
      downloads += 1;
      writeFileSync(destination, fixture.packageBytes, { mode: 0o600, flag: "wx" });
    },
    extractPackage: async (_packagePath, destination) => {
      extractions += 1;
      const executable = join(destination, "usr", "bin", "Xvfb");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, fixture.executableBytes, { mode: 0o755, flag: "wx" });
    }
  };

  const first = await prepareRepositoryLocalXvfb(options);
  const second = await prepareRepositoryLocalXvfb(options);

  assert.equal(first, second);
  assert.equal(readFileSync(first).equals(fixture.executableBytes), true);
  assert.equal(downloads, 1);
  assert.equal(extractions, 1);
  assert.equal(first.startsWith(fixture.cacheRoot), true);
});

test("fails unsupported hosts before dependency, network, or extraction work", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  let called = false;

  await assert.rejects(
    prepareRepositoryLocalXvfb({
      platform: "linux",
      architecture: "arm64",
      osReleaseText: fixture.osReleaseText,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      queryPackage: async () => {
        called = true;
      },
      downloadPackage: async () => {
        called = true;
      },
      extractPackage: async () => {
        called = true;
      }
    }),
    /No pinned Xvfb package is available/u
  );
  assert.equal(called, false);
  assert.equal(existsSync(fixture.cacheRoot), false);
});

test("fails a non-Linux platform before dependency, network, or extraction work", async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  let called = false;

  await assert.rejects(
    prepareRepositoryLocalXvfb({
      platform: "win32",
      architecture: "x64",
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      queryPackage: async () => {
        called = true;
      },
      downloadPackage: async () => {
        called = true;
      },
      extractPackage: async () => {
        called = true;
      }
    }),
    /supported only on Linux/u
  );
  assert.equal(called, false);
  assert.equal(existsSync(fixture.cacheRoot), false);
});

test("fails a host dependency version mismatch before downloading", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  let downloaded = false;

  await assert.rejects(
    prepareRepositoryLocalXvfb({
      platform: "linux",
      architecture: "x64",
      osReleaseText: fixture.osReleaseText,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      queryPackage: async () => ({ status: "ii", version: "wrong" }),
      downloadPackage: async () => {
        downloaded = true;
      }
    }),
    /requires 1:test/u
  );
  assert.equal(downloaded, false);
  assert.equal(existsSync(fixture.cacheRoot), false);
});

test("never publishes a package whose pinned digest does not match", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));

  await assert.rejects(
    prepareRepositoryLocalXvfb({
      platform: "linux",
      architecture: "x64",
      osReleaseText: fixture.osReleaseText,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      queryPackage: async () => ({ status: "ii", version: "1:test" }),
      downloadPackage: async ({ destination }) => {
        writeFileSync(destination, Buffer.alloc(fixture.packageBytes.length, 0x41), { mode: 0o600, flag: "wx" });
      }
    }),
    /failed identity or digest validation/u
  );
  assert.equal(
    existsSync(join(fixture.cacheRoot, `${fixture.manifest.packages["ubuntu:99.99:x64"].cacheKey}.package`)),
    false
  );
});

test("rejects a symbolic-link executable extracted from the archive", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  const outside = join(fixture.root, "outside-Xvfb");
  writeFileSync(outside, fixture.executableBytes, { mode: 0o755 });

  await assert.rejects(
    prepareRepositoryLocalXvfb({
      platform: "linux",
      architecture: "x64",
      osReleaseText: fixture.osReleaseText,
      manifest: fixture.manifest,
      cacheRoot: fixture.cacheRoot,
      queryPackage: async () => ({ status: "ii", version: "1:test" }),
      downloadPackage: async ({ destination }) => {
        writeFileSync(destination, fixture.packageBytes, { mode: 0o600, flag: "wx" });
      },
      extractPackage: async (_packagePath, destination) => {
        const executable = join(destination, "usr", "bin", "Xvfb");
        mkdirSync(dirname(executable), { recursive: true });
        symlinkSync(outside, executable);
      }
    }),
    (error) => error?.code === "ELOOP"
  );
  assert.equal(existsSync(join(fixture.cacheRoot, fixture.manifest.packages["ubuntu:99.99:x64"].cacheKey)), false);
});

test("concurrent preparation publishes one complete cache entry", LINUX_ONLY, async (context) => {
  const fixture = testFixture();
  context.after(() => removeTestRoot(fixture.root));
  let downloads = 0;
  let extractions = 0;
  const options = {
    platform: "linux",
    architecture: "x64",
    osReleaseText: fixture.osReleaseText,
    manifest: fixture.manifest,
    cacheRoot: fixture.cacheRoot,
    queryPackage: async () => ({ status: "ii", version: "1:test" }),
    downloadPackage: async ({ destination }) => {
      downloads += 1;
      await new Promise((resolve) => setImmediate(resolve));
      writeFileSync(destination, fixture.packageBytes, { mode: 0o600, flag: "wx" });
    },
    extractPackage: async (_packagePath, destination) => {
      extractions += 1;
      await new Promise((resolve) => setImmediate(resolve));
      const executable = join(destination, "usr", "bin", "Xvfb");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, fixture.executableBytes, { mode: 0o755, flag: "wx" });
    }
  };

  const [left, right] = await Promise.all([prepareRepositoryLocalXvfb(options), prepareRepositoryLocalXvfb(options)]);

  assert.equal(left, right);
  assert.equal(readFileSync(left).equals(fixture.executableBytes), true);
  assert.equal(downloads, 2);
  assert.equal(extractions, 2);
});

test("scheduled released-Jupyter acceptance uses only the prepared private Xvfb", () => {
  const workflow = readFileSync(new URL("../.github/workflows/released-jupyter.yml", import.meta.url), "utf8");
  const prepareStart = workflow.indexOf("      - id: prepare_xvfb\n");
  const packagedStart = workflow.indexOf("      - id: packaged_editor\n");
  const uploadStart = workflow.indexOf("      - name: Upload packaged-editor failure diagnostics\n");

  assert.notEqual(prepareStart, -1, "the workflow must prepare the pinned Xvfb package");
  assert.equal(prepareStart < packagedStart, true, "Xvfb preparation must precede packaged acceptance");
  assert.equal(packagedStart < uploadStart, true, "the packaged step must remain independently observable");

  const prepareStep = workflow.slice(prepareStart, packagedStart);
  assert.match(prepareStep, /scripts\/prepare-xvfb\.mjs", "--print-path"/u);
  assert.match(prepareStep, /appendFileSync\(process\.env\.GITHUB_OUTPUT, `executable=\$\{executable\}\\n`/u);

  const packagedStep = workflow.slice(packagedStart, uploadStart);
  assert.match(packagedStep, /^\s+OPEN_WRANGLER_EDITOR_DISPLAY: xvfb$/mu);
  assert.match(
    packagedStep,
    /^\s+OPEN_WRANGLER_XVFB_EXECUTABLE: \$\{\{ steps\.prepare_xvfb\.outputs\.executable \}\}$/mu
  );
  assert.doesNotMatch(packagedStep, /^\s+OPEN_WRANGLER_EDITOR_DISPLAY: (?:headless|current)$/mu);
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function removeTestRoot(path) {
  const metadata = lstatSync(path);
  if (!metadata?.isDirectory() || metadata.isSymbolicLink()) throw new Error("Refusing unsafe Xvfb test cleanup.");
  rmSync(path, { recursive: true });
}
