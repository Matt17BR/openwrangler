import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
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

function comparisonProfile(value, name, { product = "open-wrangler", templateKind = "configured-only" } = {}) {
  const privateRoot = resolve(value.root, "profiles", name);
  const userData = resolve(privateRoot, "user-data");
  const extensions = resolve(privateRoot, "extensions");
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  mkdirSync(extensions, { recursive: true, mode: 0o700 });
  const templateReceiptSha256 = (templateKind === "configured-only" ? "a" : "b").repeat(64);
  return {
    expectedTemplate: { kind: templateKind, receiptSha256: templateReceiptSha256 },
    profile: createDataWranglerComparisonDriverProfile({
      product,
      privateRoot,
      templateKind,
      templateReceiptSha256,
      editor: { name: "VS Code", cliPath: "/editor/code" },
      userData,
      extensions,
      sandboxArgs: ["--no-sandbox"],
      environment: { OPEN_WRANGLER_EDITOR_TEMP_ROOT: privateRoot },
      installLabel: `${name} driver installation`,
      inventoryLabel: `${name} driver inventory`
    })
  };
}

function corruptFirstDataDescriptor(path) {
  const bytes = readFileSync(path);
  let endOffset = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65_557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
      endOffset = index;
      break;
    }
  }
  assert.notEqual(endOffset, -1);
  let cursor = bytes.readUInt32LE(endOffset + 16);
  while (cursor < endOffset) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const flags = bytes.readUInt16LE(cursor + 8);
    if ((flags & 0x0008) !== 0) {
      const compressedBytes = bytes.readUInt32LE(cursor + 20);
      const localOffset = bytes.readUInt32LE(cursor + 42);
      const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
      const descriptorOffset = dataOffset + compressedBytes;
      assert.equal(bytes.readUInt32LE(descriptorOffset), 0x08074b50);
      bytes[descriptorOffset + 4] ^= 0xff;
      writeFileSync(path, bytes);
      return;
    }
    cursor += 46 + bytes.readUInt16LE(cursor + 28) + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  assert.fail("Expected the real VSCE package to contain a data descriptor.");
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

test("a comparison profile stays inside its pinned private template root", async () => {
  const value = fixture();
  try {
    const { profile, expectedTemplate } = comparisonProfile(value, "profile", {
      templateKind: "warmed"
    });
    assert.equal(profile.privateRoot, resolve(value.root, "profiles", "profile"));
    assert.equal(profile.templateKind, "warmed");
    assert.deepEqual(expectedTemplate, {
      kind: "warmed",
      receiptSha256: "b".repeat(64)
    });

    const outsideUserData = resolve(value.root, "outside-user-data");
    mkdirSync(outsideUserData, { mode: 0o700 });
    assert.throws(
      () => createDataWranglerComparisonDriverProfile({ ...profile, userData: outsideUserData }),
      /must stay inside the private comparison profile root/u
    );
    assert.throws(
      () =>
        createDataWranglerComparisonDriverProfile({
          ...profile,
          environment: { OPEN_WRANGLER_EDITOR_TEMP_ROOT: value.root }
        }),
      /profile is malformed/u
    );

    const movedExtensions = `${profile.extensions}.moved`;
    renameSync(profile.extensions, movedExtensions);
    mkdirSync(profile.extensions, { mode: 0o700 });
    let installCalled = false;
    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: profile.product,
            receipt: {},
            expectedDriver: {},
            expectedExtensions: [],
            expectedTemplate,
            profile,
            editorPhaseOptions: {}
          },
          {
            async installDriver() {
              installCalled = true;
            },
            async readInventory() {
              return [];
            },
            async runPhase() {}
          }
        ),
      /filesystem identity was pinned/u
    );
    assert.equal(installCalled, false);
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
    [
      'module["require"]("../../../di" + "st/extension.js");\n',
      /CommonJS loader outside the literal import inventory/u
    ],
    ['module.require("../../../di" + "st/extension.js");\n', /CommonJS loader outside the literal import inventory/u],
    ["const load = require; load('../../../di' + 'st/extension.js');\n", /unsupported module-loader reference/u],
    ['const indirect = require; indirect("node:fs");\n', /unsupported module-loader reference/u],
    ['void import("node:fs");\n', /unsupported module loader/u]
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

test("packaging rejects bytes that are not the inspected driver archive", async () => {
  const value = fixture();
  try {
    await assert.rejects(
      () =>
        packageDataWranglerComparisonDriver(
          { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
          {
            async createVsix(options) {
              writeFileSync(options.packagePath, Buffer.from("not-a-vsix"), { flag: "wx", mode: 0o600 });
            }
          }
        ),
      /no exact bounded end record/u
    );
  } finally {
    value.cleanup();
  }
});

test("packaging rejects a malformed descriptor in a real VSCE archive", async () => {
  const value = fixture();
  try {
    const { createVSIX } = await import("@vscode/vsce");
    await assert.rejects(
      () =>
        packageDataWranglerComparisonDriver(
          { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
          {
            async createVsix(options) {
              await createVSIX(options);
              corruptFirstDataDescriptor(options.packagePath);
            }
          }
        ),
      /malformed data descriptor/u
    );
  } finally {
    value.cleanup();
  }
});

test("the driver is packaged once, revalidated, and installed through the editor CLI", async () => {
  const value = fixture();
  try {
    let packageOptions;
    const { createVSIX } = await import("@vscode/vsce");
    const receipt = await packageDataWranglerComparisonDriver(
      { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
      {
        async createVsix(options) {
          packageOptions = options;
          return createVSIX(options);
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
    const archivePaths = receipt.vsix.archive.entries.map((entry) => entry.path);
    assert.equal(
      archivePaths.includes("extension/journey/test/extensionHost/dataWranglerComparisonNotebookTrial.js"),
      true
    );
    assert.equal(archivePaths.includes("extension/node_modules/playwright-core/package.json"), true);
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
        },
        archive: receipt.vsix.archive
      },
      packageFiles: receipt.packageFiles,
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

    const { profile } = comparisonProfile(value, "install");
    let invocation;
    let installedSha256;
    const result = await installDataWranglerComparisonDriver(
      {
        receipt,
        profile
      },
      {
        async runCli(options, commandOptions) {
          invocation = { options, commandOptions };
          const installPath = options.args[options.args.indexOf("--install-extension") + 1];
          assert.notEqual(installPath, value.vsix);
          assert.equal(Number(lstatSync(installPath, { bigint: true }).mode & 0o777n), 0o400);
          installedSha256 = (await import("node:crypto"))
            .createHash("sha256")
            .update(readFileSync(installPath))
            .digest("hex");
          return { stdout: "installed\n", stderr: "" };
        }
      }
    );
    assert.deepEqual(result, { stdout: "installed\n", stderr: "" });
    assert.equal(installedSha256, receipt.vsix.sha256);
    assert.deepEqual(invocation.commandOptions, { timeoutMs: 60_000 });
    assert.deepEqual(invocation.options.args.slice(0, 5), [
      "--user-data-dir",
      profile.userData,
      "--extensions-dir",
      profile.extensions,
      "--install-extension"
    ]);
    assert.deepEqual(invocation.options.args.slice(6), ["--force", "--no-sandbox"]);
    assert.equal(existsSync(invocation.options.args[5]), false);

    const originalBytes = readFileSync(value.vsix);
    let racedInstallSha256;
    let racedInstallPath;
    await assert.rejects(
      () =>
        installDataWranglerComparisonDriver(
          { receipt, profile },
          {
            async runCli(options) {
              racedInstallPath = options.args[options.args.indexOf("--install-extension") + 1];
              racedInstallSha256 = (await import("node:crypto"))
                .createHash("sha256")
                .update(readFileSync(racedInstallPath))
                .digest("hex");
              renameSync(value.vsix, `${value.vsix}.replaced`);
              writeFileSync(value.vsix, originalBytes, { flag: "wx", mode: 0o600 });
              return { stdout: "installed\n", stderr: "" };
            }
          }
        ),
      /changed after it was captured/u
    );
    assert.equal(racedInstallSha256, receipt.vsix.sha256);
    assert.notEqual(racedInstallPath, value.vsix);
    assert.equal(existsSync(racedInstallPath), false);
  } finally {
    value.cleanup();
  }
});

test("install cleanup refuses to traverse a rebound private root", async () => {
  const value = fixture();
  try {
    const receipt = await packageDataWranglerComparisonDriver({
      directory: value.driver,
      testModule: value.testModule,
      vsixPath: value.vsix
    });
    const { profile } = comparisonProfile(value, "cleanup");
    let installRoot;
    let displacedInstallRoot;
    await assert.rejects(
      () =>
        installDataWranglerComparisonDriver(
          { receipt, profile },
          {
            async runCli(options) {
              const installPath = options.args[options.args.indexOf("--install-extension") + 1];
              installRoot = resolve(installPath, "..");
              displacedInstallRoot = `${installRoot}.displaced`;
              renameSync(installRoot, displacedInstallRoot);
              renameSync(value.driver, installRoot);
              return { stdout: "installed\n", stderr: "" };
            }
          }
        ),
      /installation and cleanup failed/u
    );
    assert.equal(existsSync(resolve(installRoot, "package.json")), true);
    assert.equal(existsSync(resolve(displacedInstallRoot, "notebook-comparison-driver.vsix")), true);
    assert.equal(existsSync(value.driver), false);
  } finally {
    value.cleanup();
  }
});

test("an existing self-contained driver recovers after process state and source-build loss without rewriting files", async () => {
  const value = fixture();
  try {
    let packageCount = 0;
    const { createVSIX } = await import("@vscode/vsce");
    const receipt = await packageDataWranglerComparisonDriver(
      { directory: value.driver, testModule: value.testModule, vsixPath: value.vsix },
      {
        async createVsix(options) {
          packageCount += 1;
          return createVSIX(options);
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
    const expectedPath = resolve(value.root, "expected-driver.json");
    writeFileSync(expectedPath, JSON.stringify(expectedDriver), { flag: "wx", mode: 0o600 });
    const moduleUrl = new URL("./data-wrangler-comparison-driver.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--no-addons",
        "-e",
        `import { readFileSync } from "node:fs"; import { recoverDataWranglerComparisonDriver, createDataWranglerComparisonDriverStudyReceipt } from ${JSON.stringify(moduleUrl)}; const [directory, vsixPath, expectedPath] = process.argv.slice(1); const expectedDriver = JSON.parse(readFileSync(expectedPath, "utf8")); const recovered = recoverDataWranglerComparisonDriver({ directory, vsixPath, expectedDriver }); process.stdout.write(JSON.stringify(createDataWranglerComparisonDriverStudyReceipt(recovered)));`,
        value.driver,
        value.vsix,
        expectedPath
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 30_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), expectedDriver);
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

    const originalBytes = readFileSync(value.vsix);
    let reboundDuringRead = false;
    assert.throws(
      () =>
        revalidateDataWranglerComparisonDriver(receipt, {
          readFile(target, ...args) {
            const contents = readFileSync(target, ...args);
            if (typeof target === "number" && !reboundDuringRead) {
              reboundDuringRead = true;
              renameSync(value.vsix, `${value.vsix}.during-read`);
              writeFileSync(value.vsix, originalBytes, { flag: "wx", mode: 0o600 });
            }
            return contents;
          }
        }),
      /changed while its descriptor was read/u
    );
    assert.equal(reboundDuringRead, true);
  } finally {
    value.cleanup();
  }
});

test("both measured arms run with the private driver, one product, and no development path", async () => {
  const value = fixture();
  try {
    const receipt = await packageDataWranglerComparisonDriver({
      directory: value.driver,
      testModule: value.testModule,
      vsixPath: value.vsix
    });
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
      const { profile, expectedTemplate } = comparisonProfile(value, arm.product, { product: arm.product });
      const result = await runDataWranglerComparisonNeutralDriverPhase(
        {
          product: arm.product,
          receipt,
          expectedDriver,
          expectedExtensions,
          expectedTemplate,
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
    const { profile: failedProfile, expectedTemplate: failedTemplate } = comparisonProfile(value, "failure");
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
            expectedTemplate: failedTemplate,
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

    const { profile, expectedTemplate } = comparisonProfile(value, "validation");
    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: "open-wrangler",
            receipt: {},
            expectedDriver,
            expectedExtensions: [],
            expectedTemplate,
            profile,
            editorPhaseOptions: { editor: { name: "another editor" } }
          },
          { installDriver() {}, readInventory() {}, runPhase() {} }
        ),
      /cannot override their sealed editor value/u
    );

    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: "data-wrangler",
            receipt,
            expectedDriver,
            expectedExtensions: failedExtensions,
            expectedTemplate,
            profile,
            editorPhaseOptions: {}
          },
          { installDriver() {}, readInventory() {}, runPhase() {} }
        ),
      /product does not match its sealed editor profile/u
    );

    let prematureInstall = false;
    await assert.rejects(
      () =>
        runDataWranglerComparisonNeutralDriverPhase(
          {
            product: "open-wrangler",
            receipt,
            expectedDriver: { ...expectedDriver, version: "9.9.9" },
            expectedExtensions: failedExtensions,
            expectedTemplate,
            profile,
            editorPhaseOptions: {}
          },
          {
            async installDriver() {
              prematureInstall = true;
            },
            async readInventory() {
              return failedExtensions;
            },
            async runPhase() {}
          }
        ),
      /does not match the immutable study manifest before installation/u
    );
    assert.equal(prematureInstall, false);
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
