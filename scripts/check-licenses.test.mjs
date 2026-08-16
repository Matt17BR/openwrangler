import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  inspectDependencyLicensePolicy,
  inspectProjectLicensePolicy,
  inspectVendoredRuntimeLicensePolicy
} from "./check-licenses.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJsonSource = readFileSync(resolve(root, "package.json"), "utf8");
const licenseBytes = readFileSync(resolve(root, "LICENSE"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const notices = readFileSync(resolve(root, "THIRD_PARTY_NOTICES.md"), "utf8");
const jsYamlRuntimeBytes = readFileSync(resolve(root, "node_modules/js-yaml/dist/js-yaml.cjs.js"));
const jsYamlLicenseBytes = readFileSync(resolve(root, "node_modules/js-yaml/LICENSE"));

test("accepts only the reviewed MIT project license and matching package declaration", () => {
  assert.deepEqual(inspectProjectLicensePolicy({ packageJsonSource, licenseBytes }), []);

  const packageJson = JSON.parse(packageJsonSource);
  packageJson.license = "Apache-2.0";
  assert.deepEqual(inspectProjectLicensePolicy({ packageJsonSource: JSON.stringify(packageJson), licenseBytes }), [
    "package.json must declare the approved MIT project license."
  ]);

  assert.deepEqual(
    inspectProjectLicensePolicy({
      packageJsonSource,
      licenseBytes: Buffer.concat([licenseBytes, Buffer.from("drift")])
    }),
    ["LICENSE must byte-match the reviewed Open Wrangler MIT license text."]
  );
});

test("fails closed on malformed project-license inputs", () => {
  assert.deepEqual(inspectProjectLicensePolicy({ packageJsonSource: "{", licenseBytes }), [
    "package.json must contain valid JSON before its project license can be checked."
  ]);
  assert.throws(
    () => inspectProjectLicensePolicy({ packageJsonSource, licenseBytes: "MIT" }),
    /requires package metadata and exact license bytes/u
  );
});

test("requires the selected-environment fsspec notice", () => {
  assert.deepEqual(inspectDependencyLicensePolicy({ root, lock, notices }).errors, []);
  for (const replacement of ["fsspec 2026.6.0: BSD-3-Clause License", "fsspec 2026.7.0: MIT License"]) {
    assert.deepEqual(
      inspectDependencyLicensePolicy({
        root,
        lock,
        notices: notices.replace("fsspec 2026.7.0: BSD-3-Clause License", replacement)
      }).errors,
      ["THIRD_PARTY_NOTICES.md is missing fsspec 2026.7.0: BSD-3-Clause License."]
    );
  }
});

test("accepts only the exact vendored js-yaml runtime, development pin, and full MIT notice", () => {
  const input = { packageJsonSource, lock, notices, jsYamlRuntimeBytes, jsYamlLicenseBytes };
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy(input), []);

  const productionManifest = JSON.parse(packageJsonSource);
  productionManifest.dependencies = { ...productionManifest.dependencies, "js-yaml": "^5.2.3" };
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({ ...input, packageJsonSource: JSON.stringify(productionManifest) }),
    ["js-yaml must remain a development dependency because only its reviewed runtime asset is vendored."]
  );

  const unlocked = structuredClone(lock);
  unlocked.packages["node_modules/js-yaml"].dev = false;
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy({ ...input, lock: unlocked }), [
    "package-lock.json must pin js-yaml 5.2.3 as an MIT development dependency."
  ]);

  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      jsYamlRuntimeBytes: Buffer.concat([jsYamlRuntimeBytes.subarray(0, -1), Buffer.from("!")])
    }),
    ["The vendored js-yaml runtime source must byte-match its reviewed release asset."]
  );
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      jsYamlLicenseBytes: Buffer.concat([jsYamlLicenseBytes, Buffer.from("drift")])
    }),
    [
      "The js-yaml LICENSE must byte-match its reviewed MIT notice.",
      "THIRD_PARTY_NOTICES.md must include the full reviewed js-yaml MIT notice."
    ]
  );
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      notices: notices.replace("Copyright (C) 2011-2015 by Vitaly Puzrin", "Copyright removed")
    }),
    ["THIRD_PARTY_NOTICES.md must include the full reviewed js-yaml MIT notice."]
  );
});

test("fails closed on malformed vendored-runtime license inputs", () => {
  const input = { packageJsonSource, lock, notices, jsYamlRuntimeBytes, jsYamlLicenseBytes };
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy({ ...input, packageJsonSource: "{" }), [
    "package.json must contain valid JSON before the vendored runtime can be checked."
  ]);
  assert.throws(
    () => inspectVendoredRuntimeLicensePolicy({ ...input, jsYamlLicenseBytes: "MIT" }),
    /requires package metadata, exact bytes, and notices text/u
  );
});
