import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION,
  assertDataWranglerComparisonArmInventory,
  installDataWranglerComparisonDriver,
  packageDataWranglerComparisonDriver,
  proveDataWranglerComparisonJourneyGraph,
  revalidateDataWranglerComparisonDriver,
  runDataWranglerComparisonNeutralDriverPhase,
  validateDataWranglerComparisonDriverBundle,
  writeDataWranglerComparisonDriver
} from "./data-wrangler-comparison-driver.mjs";

const RUN_ID = "98765db1-ce33-4fa5-966d-16e5a9993383";

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "ow-neutral-driver-"));
  const testModule = resolve(root, "dist-test", "test", "extensionHost", "dataWranglerComparisonNotebookTrial.js");
  mkdirSync(resolve(testModule, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(testModule, "..", "neutralHelper.js"), "exports.run = async () => ({ ok: true });\n", {
    mode: 0o600
  });
  writeFileSync(testModule, 'exports.run = require("./neutralHelper").run;\n', { mode: 0o600 });
  return {
    root,
    testModule,
    driver: resolve(root, "driver"),
    vsix: resolve(root, "notebook-comparison-driver.vsix"),
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("the neutral driver has its own identity and imports only the notebook journey", () => {
  const value = fixture();
  try {
    const receipt = writeDataWranglerComparisonDriver(value.driver, value.testModule);
    assert.deepEqual(receipt.extension, DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION);
    assert.equal(receipt.directory, value.driver);
    assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/u);
    assert.match(receipt.sourceSha256, /^[0-9a-f]{64}$/u);
    assert.equal(receipt.journeyGraph.moduleCount, 2);
    assert.deepEqual(
      receipt.journeyGraph.modules.map((entry) => entry.path),
      ["test/extensionHost/dataWranglerComparisonNotebookTrial.js", "test/extensionHost/neutralHelper.js"]
    );

    const manifest = JSON.parse(readFileSync(resolve(value.driver, "package.json"), "utf8"));
    const source = readFileSync(resolve(value.driver, "extension.js"), "utf8");
    assert.equal(`${manifest.publisher}.${manifest.name}`, "openwrangler-study.notebook-comparison-driver");
    assert.equal(Object.hasOwn(manifest, "contributes"), false);
    assert.equal(Object.hasOwn(manifest, "extensionDependencies"), false);
    assert.equal(Object.hasOwn(manifest, "extensionPack"), false);
    assert.equal(source.includes("Matt17BR.openwrangler"), false);
    assert.equal(source.includes("openwrangler_runtime"), false);
    assert.equal(source.includes("vscode.extensions.getExtension"), false);
    assert.deepEqual(
      validateDataWranglerComparisonDriverBundle({ manifest, source, expectedTestModule: value.testModule }),
      {
        extension: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION,
        manifestSha256: receipt.manifestSha256,
        sourceSha256: receipt.sourceSha256
      }
    );
  } finally {
    value.cleanup();
  }
});

test("the generated extension runs the existing notebook journey and publishes the normal acceptance envelope", async () => {
  const value = fixture();
  try {
    writeDataWranglerComparisonDriver(value.driver, value.testModule);
    const source = readFileSync(resolve(value.driver, "extension.js"), "utf8");
    const resultPath = resolve(value.root, "result.json");
    const progressPath = resolve(value.root, "progress.json");
    const calls = [];
    const context = {
      Buffer,
      exports: {},
      process: {
        pid: 1234,
        env: {
          OPEN_WRANGLER_TEST_PHASE: "comparison-study-data-wrangler-trial",
          OPEN_WRANGLER_TEST_PROGRESS: progressPath,
          OPEN_WRANGLER_TEST_RESULT: resultPath,
          OPEN_WRANGLER_TEST_RUN_ID: RUN_ID
        }
      },
      require(id) {
        if (id === "node:crypto") return awaitlessCrypto();
        if (id === "node:fs") return awaitlessFs();
        if (id === "vscode") {
          return {
            commands: {
              executeCommand(command) {
                calls.push(command);
              }
            }
          };
        }
        if (id === value.testModule) {
          return {
            async run() {
              calls.push("journey");
              return { measured: true };
            }
          };
        }
        throw new Error(`Unexpected require ${id}`);
      },
      setTimeout(callback) {
        callback();
      }
    };
    vm.runInNewContext(source, context, { filename: "extension.js" });
    await context.exports.activate();
    assert.deepEqual(calls, ["journey", "workbench.action.quit", "workbench.action.closeWindow"]);
    assert.deepEqual(JSON.parse(readFileSync(resultPath, "utf8")), {
      protocol: 1,
      runId: RUN_ID,
      phase: "comparison-study-data-wrangler-trial",
      ok: true,
      evidence: { measured: true }
    });
    assert.equal(JSON.parse(readFileSync(progressPath, "utf8")).checkpoint.endsWith(":driver-start"), true);
  } finally {
    value.cleanup();
  }
});

test("the bundle validator rejects product entrypoints and any extra import", () => {
  const value = fixture();
  try {
    writeDataWranglerComparisonDriver(value.driver, value.testModule);
    const manifest = JSON.parse(readFileSync(resolve(value.driver, "package.json"), "utf8"));
    const source = readFileSync(resolve(value.driver, "extension.js"), "utf8");
    for (const injected of [
      `${source}\nrequire("/repo/dist/extension.js");\n`,
      `${source}\nrequire("node:child_process");\n`,
      `${source}\nvscode.extensions.getExtension("Matt17BR.openwrangler");\n`
    ]) {
      assert.throws(
        () =>
          validateDataWranglerComparisonDriverBundle({
            manifest,
            source: injected,
            expectedTestModule: value.testModule
          }),
        /may not import|outside its fixed neutral module list/u
      );
    }
  } finally {
    value.cleanup();
  }
});

test("the writer rejects another test module and never overwrites an existing driver directory", () => {
  const value = fixture();
  try {
    const wrongModule = resolve(value.testModule, "..", "index.js");
    writeFileSync(wrongModule, "exports.run = async () => undefined;\n", { mode: 0o600 });
    assert.throws(
      () => writeDataWranglerComparisonDriver(value.driver, wrongModule),
      /exact compiled dataWranglerComparisonNotebookTrial\.js/u
    );
    mkdirSync(value.driver, { mode: 0o700 });
    writeFileSync(resolve(value.driver, "owned.txt"), "keep\n", { mode: 0o600 });
    assert.throws(() => writeDataWranglerComparisonDriver(value.driver, value.testModule), /EEXIST/u);
    assert.equal(readFileSync(resolve(value.driver, "owned.txt"), "utf8"), "keep\n");
  } finally {
    value.cleanup();
  }
});

test("the journey proof follows the complete local graph and rejects product or harness entrypoints", () => {
  for (const [source, message] of [
    ['require("../../../dist/extension.js");\n', /left its neutral test\/shared roots|product extension/u],
    ['require("./index.js");\n', /neutral test\/shared roots/u]
  ]) {
    const value = fixture();
    try {
      if (source.includes("index.js")) {
        writeFileSync(resolve(value.testModule, "..", "index.js"), "exports.run = async () => undefined;\n", {
          mode: 0o600
        });
      }
      writeFileSync(value.testModule, source, { mode: 0o600 });
      assert.throws(() => proveDataWranglerComparisonJourneyGraph(value.testModule), message);
    } finally {
      value.cleanup();
    }
  }
});

test("the driver is packaged once, revalidated, and installed through the editor CLI", async () => {
  const value = fixture();
  try {
    let packageOptions;
    const receipt = await packageDataWranglerComparisonDriver(
      { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
      {
        async createVsix(options) {
          packageOptions = options;
          writeFileSync(options.packagePath, Buffer.from("neutral-driver-vsix"), { flag: "wx", mode: 0o600 });
        }
      }
    );
    assert.deepEqual(packageOptions, {
      cwd: value.driver,
      packagePath: value.vsix,
      dependencies: false,
      skipLicense: true,
      allowStarActivation: true,
      allowMissingRepository: true
    });
    assert.equal(revalidateDataWranglerComparisonDriver(receipt), receipt);
    assert.match(receipt.vsix.sha256, /^[0-9a-f]{64}$/u);

    let invocation;
    const result = await installDataWranglerComparisonDriver(
      {
        receipt,
        editor: { name: "VS Code", cliPath: "/editor/code" },
        userData: "/private/user-data",
        extensions: "/private/extensions",
        sandboxArgs: ["--no-sandbox"],
        environment: { HOME: "/private/home" },
        label: "neutral driver installation"
      },
      {
        async runCli(options, commandOptions) {
          invocation = { options, commandOptions };
          return { stdout: "installed\n", stderr: "" };
        }
      }
    );
    assert.deepEqual(result, { stdout: "installed\n", stderr: "" });
    assert.deepEqual(invocation.commandOptions, { timeoutMs: 60_000 });
    assert.deepEqual(invocation.options.args, [
      "--user-data-dir",
      "/private/user-data",
      "--extensions-dir",
      "/private/extensions",
      "--install-extension",
      value.vsix,
      "--force",
      "--no-sandbox"
    ]);
  } finally {
    value.cleanup();
  }
});

test("both measured arms run with the private driver, one product, and no development path", async () => {
  const products = [
    {
      product: "open-wrangler",
      measured: { extensionId: "Matt17BR.openwrangler", version: "1.2.1" }
    },
    {
      product: "data-wrangler",
      measured: { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" }
    }
  ];
  for (const arm of products) {
    const expectedExtensions = [
      {
        extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
        version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version
      },
      { extensionId: "ms-toolsai.jupyter", version: "2025.9.1" },
      arm.measured
    ];
    const inventory = assertDataWranglerComparisonArmInventory(expectedExtensions, {
      product: arm.product,
      expectedExtensions
    });
    assert.equal(inventory.length, 3);
    let installation;
    let phaseOptions;
    let inventoryReads = 0;
    const result = await runDataWranglerComparisonNeutralDriverPhase(
      {
        product: arm.product,
        receipt: { opaque: true },
        expectedExtensions,
        driverInstallation: { editor: { name: "VS Code" } },
        editorPhaseOptions: { phase: `${arm.product}-trial`, workspace: "/private/workspace" }
      },
      {
        async installDriver(value) {
          installation = value;
        },
        async readInventory() {
          inventoryReads += 1;
          return structuredClone(expectedExtensions);
        },
        async runPhase(value) {
          phaseOptions = value;
          return { ok: true };
        }
      }
    );
    assert.deepEqual(installation, { receipt: { opaque: true }, editor: { name: "VS Code" } });
    assert.equal(inventoryReads, 2);
    assert.deepEqual(phaseOptions, {
      phase: `${arm.product}-trial`,
      workspace: "/private/workspace",
      developmentPaths: []
    });
    assert.deepEqual(result.phaseResult, { ok: true });
  }

  assert.throws(
    () =>
      assertDataWranglerComparisonArmInventory(
        [
          {
            extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
            version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version
          },
          { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
          { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" }
        ],
        {
          product: "data-wrangler",
          expectedExtensions: [
            {
              extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
              version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version
            },
            { extensionId: "Matt17BR.openwrangler", version: "1.2.1" },
            { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" }
          ]
        }
      ),
    /neutral driver and exactly one measured product/u
  );
});

function awaitlessCrypto() {
  return { randomUUID: () => "7f106b58-a6e0-4f33-9dd2-79a45653a79f" };
}

function awaitlessFs() {
  return {
    writeFileSync,
    lstatSync,
    renameSync,
    rmSync
  };
}
