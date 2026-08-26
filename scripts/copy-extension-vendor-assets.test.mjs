import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "node:test";
import {
  copyExtensionVendorAssets,
  guardExtensionVendorAssets,
  JS_YAML_VENDOR_ASSET
} from "./copy-extension-vendor-assets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtures = [];

function createFixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ow-extension-vendor-")));
  fixtures.push(root);
  for (const relativePath of [JS_YAML_VENDOR_ASSET.packageManifest, JS_YAML_VENDOR_ASSET.source]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function createFixtureDirectory(prefix) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  fixtures.push(root);
  return root;
}

function createDirectoryLink(target, path) {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function nextCompatibleVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  assert.notEqual(match, null);
  const patch = Number(match[3]);
  assert.ok(Number.isSafeInteger(patch));
  assert.ok(patch < Number.MAX_SAFE_INTEGER);
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

function outputPath(root, outputRoot = "dist") {
  return join(root, outputRoot, JS_YAML_VENDOR_ASSET.output);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

test("extension vendor staging copies the installed js-yaml CommonJS runtime exactly", () => {
  const root = createFixture();
  const source = readFileSync(join(root, JS_YAML_VENDOR_ASSET.source));
  const manifest = JSON.parse(readFileSync(join(root, JS_YAML_VENDOR_ASSET.packageManifest), "utf8"));
  guardExtensionVendorAssets({ root, outputRoot: "dist" });
  const receipt = copyExtensionVendorAssets({ root, outputRoot: "dist" });
  assert.deepEqual(receipt, {
    output: { bytes: source.length, sha256: createHash("sha256").update(source).digest("hex") },
    outputRoot: "dist",
    version: manifest.version
  });
  assert.deepEqual(readFileSync(outputPath(root)), source);
  guardExtensionVendorAssets({ root, outputRoot: "dist" });
});

test("extension vendor staging refreshes stale output and rejects unexpected generated assets", () => {
  const staleRoot = createFixture();
  copyExtensionVendorAssets({ root: staleRoot, outputRoot: "dist" });
  writeFileSync(outputPath(staleRoot), "stale\n");
  guardExtensionVendorAssets({ root: staleRoot, outputRoot: "dist" });
  copyExtensionVendorAssets({ root: staleRoot, outputRoot: "dist" });
  assert.deepEqual(readFileSync(outputPath(staleRoot)), readFileSync(join(staleRoot, JS_YAML_VENDOR_ASSET.source)));

  const unexpectedRoot = createFixture();
  copyExtensionVendorAssets({ root: unexpectedRoot, outputRoot: "dist-test" });
  writeFileSync(join(dirname(outputPath(unexpectedRoot, "dist-test")), "unexpected.js"), "unexpected\n");
  assert.throws(
    () => guardExtensionVendorAssets({ root: unexpectedRoot, outputRoot: "dist-test" }),
    /contains an unexpected asset/u
  );

  const linkedOutputRoot = createFixture();
  mkdirSync(join(linkedOutputRoot, "linked-dist"));
  createDirectoryLink(join(linkedOutputRoot, "linked-dist"), join(linkedOutputRoot, "dist"));
  assert.throws(
    () => guardExtensionVendorAssets({ root: linkedOutputRoot, outputRoot: "dist" }),
    /only real directories/u
  );
});

test("extension vendor staging accepts package updates but rejects a wrong package or linked source", () => {
  const updateRoot = createFixture();
  const updateManifestPath = join(updateRoot, JS_YAML_VENDOR_ASSET.packageManifest);
  const updateManifest = JSON.parse(readFileSync(updateManifestPath, "utf8"));
  const compatibleVersion = nextCompatibleVersion(updateManifest.version);
  assert.notEqual(compatibleVersion, updateManifest.version);
  writeFileSync(updateManifestPath, `${JSON.stringify({ ...updateManifest, version: compatibleVersion })}\n`);
  assert.equal(copyExtensionVendorAssets({ root: updateRoot, outputRoot: "dist" }).version, compatibleVersion);

  const identityRoot = createFixture();
  const manifestPath = join(identityRoot, JS_YAML_VENDOR_ASSET.packageManifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: "not-js-yaml" })}\n`);
  assert.throws(
    () => copyExtensionVendorAssets({ root: identityRoot, outputRoot: "dist" }),
    /documented CommonJS entrypoint/u
  );

  const linkedRoot = createFixture();
  const sourcePath = join(linkedRoot, JS_YAML_VENDOR_ASSET.source);
  const alternatePath = join(dirname(sourcePath), "source-copy.js");
  copyFileSync(sourcePath, alternatePath);
  rmSync(sourcePath);
  symlinkSync(alternatePath, sourcePath);
  assert.throws(() => copyExtensionVendorAssets({ root: linkedRoot, outputRoot: "dist" }), /regular file/u);
});

test("extension vendor staging rejects a named pipe without blocking", { skip: process.platform === "win32" }, () => {
  const root = createFixture();
  const sourcePath = join(root, JS_YAML_VENDOR_ASSET.source);
  rmSync(sourcePath);
  const fifo = spawnSync("mkfifo", [sourcePath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);

  const moduleUrl = pathToFileURL(join(repositoryRoot, "scripts/copy-extension-vendor-assets.mjs")).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { copyExtensionVendorAssets } from ${JSON.stringify(moduleUrl)};
try {
  copyExtensionVendorAssets({ root: process.argv[1], outputRoot: "dist" });
} catch (error) {
  process.stderr.write(String(error?.message ?? error));
  process.exitCode = 7;
}`,
      root
    ],
    { encoding: "utf8", timeout: 2_000 }
  );
  assert.equal(probe.error, undefined);
  assert.equal(probe.signal, null);
  assert.equal(probe.status, 7);
  assert.match(probe.stderr, /regular file/u);
});

test("extension vendor staging rejects root aliases and symbolic links in the installed package ancestry", () => {
  const root = createFixture();
  const aliasParent = createFixtureDirectory("ow-extension-vendor-alias-");
  const rootAlias = join(aliasParent, "repository-alias");
  createDirectoryLink(root, rootAlias);
  assert.throws(
    () => copyExtensionVendorAssets({ root: rootAlias, outputRoot: "dist" }),
    /repository root must be one canonical directory/u
  );

  const linkedPackageRoot = createFixture();
  const packageRoot = dirname(join(linkedPackageRoot, JS_YAML_VENDOR_ASSET.packageManifest));
  const packageTarget = join(linkedPackageRoot, "js-yaml-package-target");
  renameSync(packageRoot, packageTarget);
  createDirectoryLink(packageTarget, packageRoot);
  assert.throws(
    () => copyExtensionVendorAssets({ root: linkedPackageRoot, outputRoot: "dist" }),
    /package manifest ancestry must contain only real directories/u
  );

  const linkedSourceParentRoot = createFixture();
  const sourceParent = dirname(join(linkedSourceParentRoot, JS_YAML_VENDOR_ASSET.source));
  const sourceParentTarget = join(dirname(sourceParent), "js-yaml-dist-target");
  renameSync(sourceParent, sourceParentTarget);
  createDirectoryLink(sourceParentTarget, sourceParent);
  assert.throws(
    () => copyExtensionVendorAssets({ root: linkedSourceParentRoot, outputRoot: "dist" }),
    /CommonJS entrypoint ancestry must contain only real directories/u
  );
});

test("extension vendor staging accepts regular hard-linked files without mutating unrelated aliases", () => {
  const root = createFixture();
  const sourcePath = join(root, JS_YAML_VENDOR_ASSET.source);
  const sourceAlias = join(dirname(sourcePath), "js-yaml-source-alias.js");
  const source = readFileSync(sourcePath);
  renameSync(sourcePath, sourceAlias);
  linkSync(sourceAlias, sourcePath);

  copyExtensionVendorAssets({ root, outputRoot: "dist" });
  assert.deepEqual(readFileSync(outputPath(root)), source);
  assert.deepEqual(readFileSync(sourceAlias), source);

  const outputAlias = join(root, "js-yaml-output-alias.js");
  linkSync(outputPath(root), outputAlias);
  const updatedSource = Buffer.concat([source, Buffer.from("\n// compatible fixture update\n")]);
  writeFileSync(sourcePath, updatedSource);
  copyExtensionVendorAssets({ root, outputRoot: "dist" });
  assert.deepEqual(readFileSync(outputPath(root)), updatedSource);
  assert.deepEqual(readFileSync(sourceAlias), updatedSource);
  assert.deepEqual(readFileSync(outputAlias), source);
});

test("extension watch prepares the exact vendored runtime before incremental compilation", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts["prewatch:extension"], undefined);
  assert.equal(manifest.scripts["watch:extension"], "npm run build:extension && tsc -w -p tsconfig.extension.json");
});
