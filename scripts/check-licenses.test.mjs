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
const jsYamlPackageJsonSource = readFileSync(resolve(root, "node_modules/js-yaml/package.json"), "utf8");
const jsYamlLicenseBytes = readFileSync(resolve(root, "node_modules/js-yaml/LICENSE"));

function nextCompatibleVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/u.exec(version);
  assert.notEqual(match, null);
  const patch = Number(match[3]);
  assert.ok(Number.isSafeInteger(patch));
  assert.ok(patch < Number.MAX_SAFE_INTEGER);
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

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

test("classifies linked packages from their lockfile-owned target", () => {
  const promoted = structuredClone(lock);
  promoted.packages["scripts/npm-shims/keytar"].dev = false;
  assert.deepEqual(inspectDependencyLicensePolicy({ root, lock: promoted, notices }).errors, [
    "keytar is not assigned to a third-party notice group."
  ]);
});

test("accepts a lockfile-owned js-yaml development dependency and its complete MIT notice", () => {
  const input = { packageJsonSource, lock, notices, jsYamlPackageJsonSource, jsYamlLicenseBytes };
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy(input), []);

  const productionManifest = JSON.parse(packageJsonSource);
  productionManifest.dependencies = {
    ...productionManifest.dependencies,
    "js-yaml": productionManifest.devDependencies["js-yaml"]
  };
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({ ...input, packageJsonSource: JSON.stringify(productionManifest) }),
    ["js-yaml must remain a development dependency because only its CommonJS runtime is bundled."]
  );

  const unlocked = structuredClone(lock);
  unlocked.packages["node_modules/js-yaml"].dev = false;
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy({ ...input, lock: unlocked }), [
    "package.json and package-lock.json must agree on one MIT js-yaml development dependency."
  ]);

  const updatedManifest = JSON.parse(packageJsonSource);
  const installedPackage = JSON.parse(jsYamlPackageJsonSource);
  const compatibleVersion = nextCompatibleVersion(installedPackage.version);
  assert.notEqual(compatibleVersion, installedPackage.version);
  updatedManifest.devDependencies["js-yaml"] = `^${compatibleVersion}`;
  const updatedLock = structuredClone(lock);
  updatedLock.packages["node_modules/js-yaml"].version = compatibleVersion;
  const updatedPackage = { ...installedPackage, version: compatibleVersion };
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      packageJsonSource: JSON.stringify(updatedManifest),
      lock: updatedLock,
      jsYamlPackageJsonSource: JSON.stringify(updatedPackage)
    }),
    []
  );

  const wrongLicense = { ...JSON.parse(jsYamlPackageJsonSource), license: "Apache-2.0" };
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      jsYamlPackageJsonSource: JSON.stringify(wrongLicense)
    }),
    ["The installed js-yaml package must match the lockfile and declare the MIT license."]
  );
  assert.deepEqual(
    inspectVendoredRuntimeLicensePolicy({
      ...input,
      jsYamlLicenseBytes: Buffer.concat([jsYamlLicenseBytes, Buffer.from("drift")])
    }),
    ["THIRD_PARTY_NOTICES.md must include js-yaml's complete installed MIT notice."]
  );
});

test("fails closed on malformed vendored-runtime license inputs", () => {
  const input = { packageJsonSource, lock, notices, jsYamlPackageJsonSource, jsYamlLicenseBytes };
  assert.deepEqual(inspectVendoredRuntimeLicensePolicy({ ...input, packageJsonSource: "{" }), [
    "Package metadata must contain valid JSON before the vendored runtime can be checked."
  ]);
  assert.throws(
    () => inspectVendoredRuntimeLicensePolicy({ ...input, jsYamlLicenseBytes: "MIT" }),
    /requires package metadata, license text, and notices text/u
  );
});
