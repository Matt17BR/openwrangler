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

it.each(["linux", "win32"] as const)(
  "settles only direct owned fixture roots at the %s cleanup boundary",
  (platform) => {
    const parent = mkdtempSync(path.join(tmpdir(), "openwrangler-cleanup-owner-"));
    const runnerParent = path.join(parent, platform === "win32" ? "Temp" : "ow");
    mkdirSync(runnerParent);
    const editorTempRoot = mkdtempSync(path.join(runnerParent, "x-"));
    const isolatedTempRoot =
      platform === "win32" ? path.join(editorTempRoot, "home", "AppData", "Local", "Temp") : editorTempRoot;
    mkdirSync(isolatedTempRoot, { recursive: true });
    const directory = mkdtempSync(path.join(isolatedTempRoot, "openwrangler-cleanup-contract-"));
    const dependencies = {
      platform,
      isolatedTempRoot,
      editorTempRoot: platform === "win32" ? editorTempRoot : undefined,
      extensionTests: "1",
      lstat: lstatSync,
      remove: rmSync
    };
    try {
      assert.throws(
        () => cleanupAcceptanceTemporaryDirectory(path.join(directory, "nested"), dependencies),
        /direct children of the isolated editor temp root/u
      );
      if (platform === "win32") {
        for (const invalidRoot of [undefined, "x-relative"]) {
          assert.throws(
            () => cleanupAcceptanceTemporaryDirectory(directory, { ...dependencies, editorTempRoot: invalidRoot }),
            /absolute runner-owned temp root/u
          );
        }
        assert.throws(
          () => cleanupAcceptanceTemporaryDirectory(directory, { ...dependencies, editorTempRoot: parent }),
          /runner-owned random temp root/u
        );
        assert.throws(
          () =>
            cleanupAcceptanceTemporaryDirectory(directory, {
              ...dependencies,
              editorTempRoot: path.join(runnerParent, "x-unrelated")
            }),
          /runner-owned profile Temp directory/u
        );
        const wrongTemp = path.join(editorTempRoot, "other");
        mkdirSync(wrongTemp);
        const wrongFixture = mkdtempSync(path.join(wrongTemp, "openwrangler-cleanup-contract-"));
        assert.throws(
          () => cleanupAcceptanceTemporaryDirectory(wrongFixture, { ...dependencies, isolatedTempRoot: wrongTemp }),
          /runner-owned profile Temp directory/u
        );
        assert.throws(
          () => cleanupAcceptanceTemporaryDirectory(directory, { ...dependencies, extensionTests: undefined }),
          /inside the editor acceptance harness/u
        );
        assert.throws(
          () =>
            cleanupAcceptanceTemporaryDirectory(directory, {
              ...dependencies,
              lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => true })
            }),
          /must remain a real directory/u
        );
        const foreignFixture = mkdtempSync(path.join(isolatedTempRoot, "foreign-"));
        assert.throws(
          () => cleanupAcceptanceTemporaryDirectory(foreignFixture, dependencies),
          /Open Wrangler-owned random directory name/u
        );
        assert.ok(existsSync(wrongFixture) && existsSync(foreignFixture));
      }
      cleanupAcceptanceTemporaryDirectory(directory, dependencies);
      assert.equal(
        existsSync(directory),
        platform === "win32",
        "Windows retains fixture roots until job-empty cleanup; other platforms remove them immediately."
      );
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
);
