import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPARISON_COMMON_EXTENSION_LOCK,
  DATA_WRANGLER_MARKETPLACE_EXTENSION,
  installComparisonExtension,
  verifyComparisonExtensionInventory
} from "./data-wrangler-comparison-install.mjs";

const command = Object.freeze({
  editor: { cli: "/code" },
  userData: "/private/user-data",
  extensions: "/private/extensions",
  sandboxArgs: ["--no-sandbox"],
  environment: { HOME: "/private/home" },
  label: "Comparison extensions"
});

test("installs only pinned Marketplace extensions or the owned candidate", async () => {
  const calls = [];
  const runCli = async (...arguments_) => {
    calls.push(arguments_);
    return { stdout: "", stderr: "" };
  };
  await installComparisonExtension(
    { ...command, target: DATA_WRANGLER_MARKETPLACE_EXTENSION, kind: "marketplace" },
    { runCli }
  );
  await installComparisonExtension(
    {
      ...command,
      target: "/private/openwrangler.vsix",
      kind: "owned-vsix",
      allowedPrivateVsixPaths: ["/private/openwrangler.vsix"]
    },
    { runCli }
  );

  assert.deepEqual(calls[0][0].args, [
    "--user-data-dir",
    command.userData,
    "--extensions-dir",
    command.extensions,
    "--install-extension",
    DATA_WRANGLER_MARKETPLACE_EXTENSION,
    "--force",
    "--no-sandbox"
  ]);
  assert.equal(calls[0][1].timeoutMs, 180_000);
  assert.equal(calls[1][0].args[5], "/private/openwrangler.vsix");
  await assert.rejects(
    installComparisonExtension({ ...command, target: "publisher.unpinned@1.0.0", kind: "marketplace" }, { runCli }),
    /pinned extension IDs/u
  );
});

test("verifies the complete product-specific inventory with the official CLI", async () => {
  const expected = [...COMPARISON_COMMON_EXTENSION_LOCK, "Matt17BR.openwrangler@1.2.1"];
  const calls = [];
  const installed = await verifyComparisonExtensionInventory(
    { ...command, product: "open-wrangler", productVersion: "1.2.1" },
    {
      runCli: async (...arguments_) => {
        calls.push(arguments_);
        return { stdout: `${expected.reverse().join("\n")}\n`, stderr: "" };
      }
    }
  );

  assert.equal(installed.includes("matt17br.openwrangler@1.2.1"), true);
  assert.deepEqual(calls[0][0].args, [
    "--user-data-dir",
    command.userData,
    "--extensions-dir",
    command.extensions,
    "--list-extensions",
    "--show-versions",
    "--no-sandbox"
  ]);
  assert.deepEqual(calls[0][1], { timeoutMs: 60_000, maxOutputBytes: 65_536 });
});

test("rejects extra, duplicate, malformed, and wrong-version inventories", async () => {
  const base = [...COMPARISON_COMMON_EXTENSION_LOCK, DATA_WRANGLER_MARKETPLACE_EXTENSION];
  const verify = (lines, productVersion = "1.24.2") =>
    verifyComparisonExtensionInventory(
      { ...command, product: "data-wrangler", productVersion },
      { runCli: async () => ({ stdout: `${lines.join("\n")}\n`, stderr: "" }) }
    );

  await assert.rejects(verify([...base, "publisher.extra@1.0.0"]), /exact locked/u);
  await assert.rejects(verify([...base, base[0]]), /unique entries/u);
  await assert.rejects(verify([...base.slice(0, -1), "not-an-extension"]), /malformed/u);
  await assert.rejects(verify(base, "1.25.0"), /Data Wrangler 1\.24\.2/u);
});
