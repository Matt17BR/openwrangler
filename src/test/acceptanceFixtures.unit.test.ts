import * as assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { it } from "vitest";
import { assertExactBytes } from "./extensionHost/acceptanceSourceFixture";
import { cleanupAcceptanceTemporaryDirectory } from "./extensionHost/acceptanceTemporaryDirectory";

it("keeps large source mismatch diagnostics bounded", () => {
  const expected = Buffer.alloc(2 * 1024 * 1024);
  const actual = Buffer.from(expected);
  actual[actual.length - 1] = 1;

  let diagnostic = "";
  try {
    assertExactBytes(actual, expected, "Synthetic large source preservation mismatch.");
  } catch (error) {
    diagnostic = String(error);
  }
  assert.ok(diagnostic, "The synthetic byte mismatch must fail.");
  assert.ok(diagnostic.length < 512, "Exact-byte mismatch diagnostics must remain bounded.");
  assert.match(diagnostic, /offset 2097151; expected 0, received 1/u);
  assert.doesNotMatch(diagnostic, /<Buffer|actual:|expected:/u);
});

it("settles only direct owned fixture roots at the platform cleanup boundary", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "openwrangler-cleanup-owner-"));
  const runnerParent = path.join(parent, "ow");
  mkdirSync(runnerParent);
  const isolatedTempRoot = mkdtempSync(path.join(runnerParent, "x-"));
  const directory = mkdtempSync(path.join(isolatedTempRoot, "openwrangler-cleanup-contract-"));
  const dependencies = {
    platform: process.platform,
    isolatedTempRoot,
    extensionTests: "1",
    lstat: lstatSync,
    remove: rmSync
  };
  try {
    assert.throws(
      () => cleanupAcceptanceTemporaryDirectory(path.join(directory, "nested"), dependencies),
      /direct children of the isolated editor temp root/u
    );
    cleanupAcceptanceTemporaryDirectory(directory, dependencies);
    assert.equal(
      existsSync(directory),
      process.platform === "win32",
      "Windows retains fixture roots until job-empty cleanup; other platforms remove them immediately."
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
