import assert from "node:assert/strict";
import test from "node:test";
import { resolveCurrentChannelPackageArguments } from "./package-current-channel.mjs";

function manifest(version, preview) {
  return JSON.stringify({ preview, version });
}

test("derives preview and stable VSCE arguments from validated package metadata", () => {
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("0.3.0", true)
    }),
    ["package", "--pre-release", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--pre-release", "--out", "openwrangler.vsix"],
      packageJson: manifest("0.3.0", true)
    }),
    ["package", "--pre-release", "--out", "openwrangler.vsix"]
  );
  assert.deepEqual(
    resolveCurrentChannelPackageArguments({
      arguments_: ["--out", "openwrangler.vsix"],
      packageJson: manifest("1.0.0", false)
    }),
    ["package", "--out", "openwrangler.vsix"]
  );
});

test("rejects contradictory metadata and caller-controlled channel overrides", () => {
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: [],
        packageJson: manifest("0.3.0", false)
      }),
    /requires package\.json "preview" to be true/u
  );
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: [],
        packageJson: manifest("1.0.0", true)
      }),
    /requires package\.json "preview" to be false/u
  );
  assert.throws(
    () =>
      resolveCurrentChannelPackageArguments({
        arguments_: ["--pre-release", "--out", "openwrangler.vsix"],
        packageJson: manifest("1.0.0", false)
      }),
    /must not receive --pre-release/u
  );
  for (const arguments_ of [
    ["--pre-release", "--pre-release"],
    ["--pre-release=true", "--out", "openwrangler.vsix"],
    ["--no-pre-release", "--out", "openwrangler.vsix"],
    ["--", "--out", "openwrangler.vsix"],
    ["1.0.0", "--out", "openwrangler.vsix"],
    ["--out", "--pre-release"],
    ["--out", "openwrangler.vsix", "--unknown"]
  ]) {
    assert.throws(
      () =>
        resolveCurrentChannelPackageArguments({
          arguments_,
          packageJson: manifest("0.3.0", true)
        }),
      /must be exactly --out/u
    );
  }
});

test("rejects malformed, duplicate-key, and nonnumeric manifests", () => {
  for (const packageJson of [
    '{"version":"0.3.0","version":"1.0.0","preview":false}',
    "[]",
    manifest("1.0.0-alpha.1", false),
    JSON.stringify({ version: "1.0.0" })
  ]) {
    assert.throws(
      () => resolveCurrentChannelPackageArguments({ arguments_: [], packageJson }),
      /package-current-channel/u
    );
  }
});
