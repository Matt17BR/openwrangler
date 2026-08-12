import assert from "node:assert/strict";
import {
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, test } from "node:test";
import {
  copyExtensionVendorAssets,
  guardExtensionVendorAssets,
  JS_YAML_VENDOR_ASSET
} from "./copy-extension-vendor-assets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const fixtures = [];

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ow-extension-vendor-"));
  fixtures.push(root);
  for (const relativePath of [JS_YAML_VENDOR_ASSET.packageManifest, JS_YAML_VENDOR_ASSET.source]) {
    const destination = join(root, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(repositoryRoot, relativePath), destination);
  }
  return root;
}

function outputPath(root, outputRoot = "dist") {
  return join(root, outputRoot, JS_YAML_VENDOR_ASSET.output);
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { force: true, recursive: true });
});

test("extension vendor staging copies and verifies the exact pinned js-yaml bytes", () => {
  const root = createFixture();
  guardExtensionVendorAssets({ root, outputRoot: "dist" });
  const receipt = copyExtensionVendorAssets({ root, outputRoot: "dist" });
  assert.deepEqual(receipt, {
    output: { bytes: JS_YAML_VENDOR_ASSET.bytes, sha256: JS_YAML_VENDOR_ASSET.sha256 },
    outputRoot: "dist"
  });
  assert.deepEqual(readFileSync(outputPath(root)), readFileSync(join(root, JS_YAML_VENDOR_ASSET.source)));
  guardExtensionVendorAssets({ root, outputRoot: "dist" });
});

test("extension vendor pre-build guard rejects stale and unexpected generated assets", () => {
  const staleRoot = createFixture();
  copyExtensionVendorAssets({ root: staleRoot, outputRoot: "dist" });
  writeFileSync(outputPath(staleRoot), "stale\n");
  assert.throws(() => guardExtensionVendorAssets({ root: staleRoot, outputRoot: "dist" }), /stale or unexpected/u);

  const unexpectedRoot = createFixture();
  copyExtensionVendorAssets({ root: unexpectedRoot, outputRoot: "dist-test" });
  writeFileSync(join(dirname(outputPath(unexpectedRoot, "dist-test")), "unexpected.js"), "unexpected\n");
  assert.throws(
    () => guardExtensionVendorAssets({ root: unexpectedRoot, outputRoot: "dist-test" }),
    /contains an unexpected asset/u
  );
});

test("extension vendor staging rejects changed package identity and linked source files", () => {
  const identityRoot = createFixture();
  const manifestPath = join(identityRoot, JS_YAML_VENDOR_ASSET.packageManifest);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: "5.2.4" })}\n`);
  assert.throws(
    () => copyExtensionVendorAssets({ root: identityRoot, outputRoot: "dist" }),
    /identity or CommonJS entrypoint/u
  );

  const linkedRoot = createFixture();
  const sourcePath = join(linkedRoot, JS_YAML_VENDOR_ASSET.source);
  const alternatePath = join(dirname(sourcePath), "source-copy.js");
  copyFileSync(sourcePath, alternatePath);
  unlinkSync(sourcePath);
  linkSync(alternatePath, sourcePath);
  assert.throws(() => copyExtensionVendorAssets({ root: linkedRoot, outputRoot: "dist" }), /single-link regular file/u);
});

test("extension watch prepares the exact vendored runtime before incremental compilation", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.scripts["prewatch:extension"], "npm run build:extension");
  assert.equal(manifest.scripts["watch:extension"], "tsc -w -p tsconfig.extension.json");
});
