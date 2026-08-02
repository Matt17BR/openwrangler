import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { inspectProjectLicensePolicy } from "./check-licenses.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJsonSource = readFileSync(resolve(root, "package.json"), "utf8");
const licenseBytes = readFileSync(resolve(root, "LICENSE"));

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
