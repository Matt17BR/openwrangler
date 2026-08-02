import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION,
  assertDataWranglerComparisonArmInventory,
  createDataWranglerComparisonDriverProfile,
  createDataWranglerComparisonDriverStudyReceipt,
  installDataWranglerComparisonDriver,
  packageDataWranglerComparisonDriver,
  proveDataWranglerComparisonJourneyGraph,
  recoverDataWranglerComparisonDriver,
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
  writeFileSync(
    resolve(testModule, "..", "neutralHelper.js"),
    'require("playwright-core"); exports.run = async () => ({ ok: true });\n',
    { mode: 0o600 }
  );
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
    assert.deepEqual(validateDataWranglerComparisonDriverBundle({ manifest, source }), {
      extension: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION,
      manifestSha256: receipt.manifestSha256,
      sourceSha256: receipt.sourceSha256
    });
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
        if (id === "./journey/test/extensionHost/dataWranglerComparisonNotebookTrial.js") {
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
      `${source}\nvscode.extensions.getExtension("Matt17BR.openwrangler");\n`,
      `${source}\nvoid import("/repo/dist/" + "extension.js");\n`
    ]) {
      assert.throws(
        () =>
          validateDataWranglerComparisonDriverBundle({
            manifest,
            source: injected
          }),
        /may not import|outside its fixed neutral module list|unsupported module loader/u
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
    ['require("./index.js");\n', /neutral test\/shared roots/u],
    ['void import("../../../dist/" + "extension.js");\n', /unsupported module loader/u],
    ['require("node:net");\n', /unapproved external package node:net/u],
    ['module["require"]("../../../di" + "st/extension.js");\n', /indirect module-loader reference/u],
    ['module.require("../../../di" + "st/extension.js");\n', /unsupported module-loader reference/u],
    ["const load = require; load('../../../di' + 'st/extension.js');\n", /unsupported module-loader reference/u],
    ['process.getBuiltinModule("module");\n', /unsupported module-loader reference/u],
    ['eval("1");\n', /unsupported module-loader reference/u]
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
      dependencies: true,
      skipLicense: true,
      allowStarActivation: true,
      allowMissingRepository: true
    });
    assert.equal(revalidateDataWranglerComparisonDriver(receipt), receipt);
    assert.match(receipt.vsix.sha256, /^[0-9a-f]{64}$/u);
    assert.deepEqual(createDataWranglerComparisonDriverStudyReceipt(receipt), {
      extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
      version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version,
      vsix: {
        sha256: receipt.vsix.sha256,
        filesystemIdentity: {
          device: receipt.vsix.identity.dev,
          inode: receipt.vsix.identity.ino,
          sizeBytes: receipt.vsix.bytes,
          mtimeNs: receipt.vsix.identity.mtimeNs
        }
      },
      runtimeDependencies: {
        playwrightCore: { ...receipt.runtimeDependencies.playwrightCore }
      },
      journeyGraph: {
        entry: "test/extensionHost/dataWranglerComparisonNotebookTrial.js",
        moduleCount: 2,
        totalBytes: receipt.journeyGraph.totalBytes,
        graphSha256: receipt.journeyGraph.graphSha256,
        modules: receipt.journeyGraph.modules.map(({ path, sha256 }) => ({ path, sha256 }))
      }
    });

    const profile = createDataWranglerComparisonDriverProfile({
      editor: { name: "VS Code", cliPath: "/editor/code" },
      userData: "/private/user-data",
      extensions: "/private/extensions",
      sandboxArgs: ["--no-sandbox"],
      environment: { HOME: "/private/home" },
      installLabel: "neutral driver installation",
      inventoryLabel: "neutral driver inventory"
    });
    let invocation;
    const result = await installDataWranglerComparisonDriver(
      {
        receipt,
        profile
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

test("an existing self-contained driver recovers after process state and source-build loss without rewriting files", async () => {
  const value = fixture();
  try {
    let packageCount = 0;
    const receipt = await packageDataWranglerComparisonDriver(
      { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
      {
        async createVsix(options) {
          packageCount += 1;
          writeFileSync(options.packagePath, Buffer.from("neutral-driver-vsix"), { flag: "wx", mode: 0o600 });
        }
      }
    );
    const expectedDriver = JSON.parse(JSON.stringify(createDataWranglerComparisonDriverStudyReceipt(receipt)));
    const watchedPaths = [resolve(value.driver, "package.json"), resolve(value.driver, "extension.js"), value.vsix];
    const before = watchedPaths.map((path) => {
      const metadata = lstatSync(path, { bigint: true });
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs
      };
    });
    rmSync(resolve(value.root, "dist-test"), { recursive: true, force: true });

    assert.throws(
      () =>
        recoverDataWranglerComparisonDriver({
          directory: value.driver,
          vsixPath: value.vsix,
          expectedDriver: {
            ...expectedDriver,
            vsix: { ...expectedDriver.vsix, sha256: "0".repeat(64) }
          }
        }),
      /does not match the immutable study manifest/u
    );
    const recovered = recoverDataWranglerComparisonDriver({
      directory: value.driver,
      vsixPath: value.vsix,
      expectedDriver
    });
    assert.notEqual(recovered, receipt);
    assert.deepEqual(createDataWranglerComparisonDriverStudyReceipt(recovered), expectedDriver);
    const after = watchedPaths.map((path) => {
      const metadata = lstatSync(path, { bigint: true });
      return {
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
        ctimeNs: metadata.ctimeNs
      };
    });
    assert.deepEqual(after, before);
    assert.equal(packageCount, 1);
  } finally {
    value.cleanup();
  }
});

test("both measured arms run with the private driver, one product, and no development path", async () => {
  const value = fixture();
  try {
    const receipt = await packageDataWranglerComparisonDriver(
      { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
      {
        async createVsix(options) {
          writeFileSync(options.packagePath, Buffer.from("neutral-driver-vsix"), { flag: "wx", mode: 0o600 });
        }
      }
    );
    const expectedDriver = createDataWranglerComparisonDriverStudyReceipt(receipt);
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
      let phaseDependencies;
      let inventoryReads = 0;
      const profile = createDataWranglerComparisonDriverProfile({
        editor: { name: "VS Code", executable: "/editor/code" },
        userData: "/private/user-data",
        extensions: "/private/extensions",
        sandboxArgs: ["--no-sandbox"],
        environment: { HOME: "/private/home" },
        installLabel: "neutral driver installation",
        inventoryLabel: "neutral driver inventory"
      });
      const result = await runDataWranglerComparisonNeutralDriverPhase(
        {
          product: arm.product,
          receipt,
          expectedDriver,
          expectedExtensions,
          profile,
          editorPhaseOptions: { phase: `${arm.product}-trial`, workspace: "/private/workspace" }
        },
        {
          async installDriver(value) {
            installation = value;
          },
          async readInventory(input) {
            inventoryReads += 1;
            assert.equal(input.profile, profile);
            assert.equal(input.stage, inventoryReads === 1 ? "before" : "after");
            return structuredClone(expectedExtensions);
          },
          async runPhase(value, dependencies) {
            phaseOptions = value;
            phaseDependencies = dependencies;
            return { ok: true };
          }
        }
      );
      assert.deepEqual(installation, { receipt, profile });
      assert.equal(inventoryReads, 2);
      assert.deepEqual(phaseOptions, {
        phase: `${arm.product}-trial`,
        workspace: "/private/workspace",
        editor: profile.editor,
        userData: profile.userData,
        extensions: profile.extensions,
        developmentPaths: []
      });
      assert.deepEqual(phaseDependencies, { driverBefore: result.driverBefore, environment: profile.environment });
      assert.deepEqual(result.phaseResult, { ok: true });
      assert.deepEqual(result.driverBefore, result.driverAfter);
      assert.equal(result.driverBefore.vsix.sha256, receipt.vsix.sha256);
    }

    const failedExtensions = [
      {
        extensionId: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.extensionId,
        version: DATA_WRANGLER_COMPARISON_DRIVER_EXTENSION.version
      },
      { extensionId: "ms-toolsai.jupyter", version: "2025.9.1" },
      { extensionId: "Matt17BR.openwrangler", version: "1.2.1" }
    ];
    const failedProfile = createDataWranglerComparisonDriverProfile({
      editor: { name: "VS Code", executable: "/editor/code" },
      userData: "/private/failure-user-data",
      extensions: "/private/failure-extensions",
      sandboxArgs: [],
      environment: { HOME: "/private/failure-home" },
      installLabel: "failure driver installation",
      inventoryLabel: "failure driver inventory"
    });
    const primaryFailure = new Error("primary measured phase failure");
    let terminalValidation;
    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: "open-wrangler",
            receipt,
            expectedDriver,
            expectedExtensions: failedExtensions,
            profile: failedProfile,
            editorPhaseOptions: { phase: "failed-trial" }
          },
          {
            async installDriver() {},
            async readInventory() {
              return structuredClone(failedExtensions);
            },
            async runPhase() {
              throw primaryFailure;
            },
            async onAfterValidation(value) {
              terminalValidation = value;
            }
          }
        ),
      (error) => error === primaryFailure
    );
    assert.deepEqual(terminalValidation.driverBefore, terminalValidation.driverAfter);

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

    const profile = createDataWranglerComparisonDriverProfile({
      editor: { name: "VS Code" },
      userData: "/private/user-data",
      extensions: "/private/extensions",
      sandboxArgs: [],
      environment: {},
      installLabel: "install",
      inventoryLabel: "inventory"
    });
    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: "open-wrangler",
            receipt: {},
            expectedDriver,
            expectedExtensions: [],
            profile,
            editorPhaseOptions: { editor: { name: "another editor" } }
          },
          { installDriver() {}, readInventory() {}, runPhase() {} }
        ),
      /cannot override their sealed editor value/u
    );
  } finally {
    value.cleanup();
  }
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
