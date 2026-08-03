#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  captureDataWranglerPreparationFile,
  captureDataWranglerProfileTree,
  createDataWranglerComparisonPreparationReceipt,
  createDataWranglerTemplateCapture,
  probeDataWranglerComparisonPython,
  queryDataWranglerTemplateInventory,
  writeDataWranglerComparisonPreparationReceipt
} from "./data-wrangler-comparison-preparation.mjs";
import { capturePreparedDataWranglerPublicUi } from "./data-wrangler-comparison-public-capture.mjs";
import {
  canonicalStudyJson,
  digestStudyValue,
  writeDataWranglerStudyJsonExclusive
} from "./data-wrangler-comparison-study.mjs";
import { configureEditorAcceptanceTempRoot, createEditorAcceptanceEnvironment } from "./editor-acceptance.mjs";
import { PINNED_REMOTE_WORKSPACE_TARGETS } from "./remote-workspace-acquisition.mjs";
import { runDataWranglerComparison } from "./run-data-wrangler-comparison.mjs";
import { runDataWranglerComparisonStudy } from "./run-data-wrangler-comparison-study.mjs";
import { readBoundedJson } from "./run-installed-performance.mjs";
import { inspectVsixArchive, readBoundedVsixFileSnapshot } from "./vsix-archive.mjs";

const MAX_SPECIFICATION_BYTES = 32 * 1024 * 1024;

function fail(message) {
  throw new TypeError(message);
}

function parseArguments(argv, cwd = process.cwd()) {
  const flags = [
    "--spec",
    "--candidate",
    "--python",
    "--cache-controller",
    "--driver-directory",
    "--driver-vsix",
    "--csv",
    "--parquet",
    "--manifest",
    "--preparation",
    "--smoke-report"
  ];
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flags.includes(flag) ||
      values.has(flag) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.startsWith("--") ||
      /[\0\r\n]/u.test(value)
    ) {
      fail(`Usage: npm run comparison:prepare -- ${flags.map((flag) => `${flag} <path>`).join(" ")}`);
    }
    values.set(flag, resolve(cwd, value));
  }
  if (values.size !== flags.length) {
    fail(`Usage: npm run comparison:prepare -- ${flags.map((flag) => `${flag} <path>`).join(" ")}`);
  }
  return Object.freeze(
    Object.fromEntries(
      flags.map((flag) => [flag.slice(2).replace(/-([a-z])/gu, (_m, c) => c.toUpperCase()), values.get(flag)])
    )
  );
}

function fileIdentity(receipt) {
  return structuredClone(receipt.filesystemIdentity);
}

async function candidateIdentity(path) {
  const snapshot = readBoundedVsixFileSnapshot(path, { requireOwner: true });
  const archive = await inspectVsixArchive(snapshot.bytes);
  const packageJson = JSON.parse(archive.packagedPackageJson);
  if (
    packageJson.publisher !== "Matt17BR" ||
    packageJson.name !== "openwrangler" ||
    typeof packageJson.version !== "string"
  ) {
    fail("Comparison preparation candidate is not the Open Wrangler package.");
  }
  const receipt = captureDataWranglerPreparationFile(path, "Comparison preparation candidate");
  if (receipt.sha256 !== createHash("sha256").update(snapshot.bytes).digest("hex")) {
    fail("Comparison preparation candidate changed during archive inspection.");
  }
  return Object.freeze({ receipt, version: packageJson.version });
}

function writeKernel(studyRoot, pythonPath, ipykernelVersion) {
  const name = `openwrangler-study-${randomUUID().replaceAll("-", "")}`;
  const jupyterRoot = resolve(studyRoot, "jupyter");
  const environment = {
    dataDir: resolve(jupyterRoot, "data"),
    runtimeDir: resolve(jupyterRoot, "runtime"),
    configDir: resolve(jupyterRoot, "config"),
    path: resolve(jupyterRoot, "path")
  };
  const kernelDirectory = resolve(environment.dataDir, "kernels", name);
  for (const directory of [...Object.values(environment), kernelDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const displayName = `Open Wrangler study CPython ${ipykernelVersion}`;
  const path = resolve(kernelDirectory, "kernel.json");
  const value = {
    argv: [pythonPath, "-I", "-Xfrozen_modules=off", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
    display_name: displayName,
    language: "python",
    metadata: { debugger: false }
  };
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const receipt = captureDataWranglerPreparationFile(path, "Comparison preparation kernelspec");
  return Object.freeze({ path, name, displayName, environment, sha256: receipt.sha256 });
}

function editorAcquisitionRoot(studyRoot, editor) {
  const relativeExecutable = relative(studyRoot, editor.executable);
  const first = relativeExecutable.split(sep)[0];
  if (first.length === 0 || first === ".." || relativeExecutable.startsWith(`..${sep}`)) {
    fail("Comparison preparation editor is not inside its retained study root.");
  }
  return resolve(studyRoot, first);
}

function expectedExtensions(specification, candidateVersion, product) {
  const measured =
    product === "open-wrangler"
      ? { extensionId: "Matt17BR.openwrangler", version: candidateVersion }
      : { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" };
  return [...specification.provenance.commonExtensions.map((entry) => ({ ...entry })), measured];
}

function assertTemplateInventory(actual, expected) {
  const normalize = (entries) => entries.map((entry) => `${entry.extensionId.toLowerCase()}@${entry.version}`).sort();
  const observed = normalize(actual);
  const required = normalize(expected);
  if (observed.length !== required.length || observed.some((entry, index) => entry !== required[index])) {
    fail("Comparison preparation profile does not contain its exact product extension inventory.");
  }
}

function updateFixture(specification, format, receipt) {
  const fixture = specification.fixtures.find((entry) => entry.format === format);
  if (fixture === undefined) fail(`Comparison preparation specification has no ${format} fixture.`);
  fixture.sha256 = receipt.sha256;
  fixture.filesystemIdentity = fileIdentity(receipt);
}

export async function prepareDataWranglerComparisonStudy(options, environment = process.env, overrides = {}) {
  const dependencies = {
    runSmoke: runDataWranglerComparison,
    readSpecification: (path) => readBoundedJson(path, MAX_SPECIFICATION_BYTES),
    queryInventory: queryDataWranglerTemplateInventory,
    captureTree: captureDataWranglerProfileTree,
    candidateIdentity,
    probePython: probeDataWranglerComparisonPython,
    captureFile: captureDataWranglerPreparationFile,
    writeStudyJson: writeDataWranglerStudyJsonExclusive,
    plan: runDataWranglerComparisonStudy,
    createReceipt: createDataWranglerComparisonPreparationReceipt,
    writeReceipt: writeDataWranglerComparisonPreparationReceipt,
    capturePublicUi: capturePreparedDataWranglerPublicUi,
    ...overrides
  };
  const specification = structuredClone(dependencies.readSpecification(options.spec));
  const candidate = await dependencies.candidateIdentity(options.candidate);
  const python = dependencies.probePython(options.python);
  let templateCapture;
  let studyRoot;
  let identifiedEditor;
  await dependencies.runSmoke(
    { candidate: options.candidate, python: options.python, output: options.smokeReport },
    environment,
    {
      retainPrivateRoot: true,
      captureTemplate: async (value) => {
        const root = dirname(value.privateRoot);
        if (studyRoot === undefined) {
          studyRoot = root;
          templateCapture = createDataWranglerTemplateCapture(root);
        } else if (studyRoot !== root) {
          fail("Comparison preparation products were not created inside one retained root.");
        }
        if (identifiedEditor === undefined) identifiedEditor = value.editor;
        if (
          identifiedEditor.executable !== value.editor.executable ||
          identifiedEditor.cli !== value.editor.cli ||
          identifiedEditor.version !== value.editor.version
        )
          fail("Comparison preparation editor changed between profile templates.");
        await templateCapture.capture(value);
      }
    }
  );
  if (studyRoot === undefined || identifiedEditor === undefined || templateCapture === undefined) {
    fail("Comparison preparation smoke did not retain its editor and profile templates.");
  }
  const templates = templateCapture.values();
  const profileEnvironment = createEditorAcceptanceEnvironment(environment, {
    OPEN_WRANGLER_EDITOR_DISPLAY: "headless",
    OPEN_WRANGLER_EDITOR_TEMP_ROOT: studyRoot
  });
  configureEditorAcceptanceTempRoot(studyRoot, profileEnvironment);
  const templateProvenance = [];
  const templateTrees = new Map();
  for (const product of ["open-wrangler", "data-wrangler"]) {
    const productTemplates = {};
    for (const kind of ["configured-only", "warmed"]) {
      const template = templates.find((entry) => entry.product === product && entry.kind === kind);
      const inventory = await dependencies.queryInventory(template, identifiedEditor, profileEnvironment);
      assertTemplateInventory(inventory, expectedExtensions(specification, candidate.version, product));
      productTemplates[kind] = dependencies.captureTree(template.root).treeSha256;
      templateTrees.set(`${product}:${kind}`, productTemplates[kind]);
    }
    templateProvenance.push({
      product,
      configuredOnlyReceiptSha256: productTemplates["configured-only"],
      warmedReceiptSha256: productTemplates.warmed,
      publicConfigurationCompleted: true,
      publicWarmupCompleted: true,
      targetStateAbsent: true
    });
  }
  const pythonFile = dependencies.captureFile(options.python, "Comparison preparation Python", { executable: true });
  const ipykernel = python.packages.find((entry) => entry.name === "ipykernel");
  const kernel = writeKernel(studyRoot, options.python, ipykernel.version);
  specification.candidate = {
    extensionId: "Matt17BR.openwrangler",
    version: candidate.version,
    sha256: candidate.receipt.sha256,
    filesystemIdentity: fileIdentity(candidate.receipt)
  };
  specification.baseline = { extensionId: "ms-toolsai.datawrangler", version: "1.24.2" };
  specification.editor = {
    id: "Microsoft.VisualStudioCode",
    version: identifiedEditor.version,
    sha256: PINNED_REMOTE_WORKSPACE_TARGETS.vscode.wireSha256,
    uiLocale: "en"
  };
  specification.python = {
    implementation: python.implementation,
    version: python.version,
    executableSha256: pythonFile.sha256,
    environmentSha256: digestStudyValue({
      executableSha256: pythonFile.sha256,
      packages: python.packages,
      kernelspecSha256: kernel.sha256
    }),
    packages: python.packages.map((entry) => ({ ...entry })),
    kernel: {
      implementation: "ipykernel",
      version: ipykernel.version,
      kernelspecName: kernel.name,
      kernelspecSha256: kernel.sha256
    }
  };
  const csv = dependencies.captureFile(options.csv, "Comparison preparation CSV fixture");
  const parquet = dependencies.captureFile(options.parquet, "Comparison preparation Parquet fixture");
  updateFixture(specification, "csv", csv);
  updateFixture(specification, "parquet", parquet);
  specification.provenance.templates = templateProvenance;
  const publicUi = await dependencies.capturePublicUi(
    {
      specification,
      templates,
      templateTrees,
      studyRoot,
      editor: identifiedEditor,
      pythonPath: options.python,
      kernel,
      fixturePaths: { csv: options.csv, parquet: options.parquet },
      driverDirectory: options.driverDirectory,
      driverVsixPath: options.driverVsix
    },
    profileEnvironment
  );
  specification.provenance.capabilities = publicUi.capabilities.map((entry) => structuredClone(entry));
  specification.provenance.controlProfile = structuredClone(publicUi.controlProfile);
  delete specification.provenance.cacheToolchain;
  const preparedSpecificationPath = resolve(studyRoot, "prepared-specification.json");
  dependencies.writeStudyJson(preparedSpecificationPath, specification);
  const planned = dependencies.plan(
    [
      "plan",
      "--spec",
      preparedSpecificationPath,
      "--out",
      options.manifest,
      "--cache-controller",
      options.cacheController,
      "--python",
      options.python
    ],
    { cwd: process.cwd() }
  );
  const installationRoot = editorAcquisitionRoot(studyRoot, identifiedEditor);
  const receipt = await dependencies.createReceipt({
    manifestPath: options.manifest,
    studyRoot,
    candidatePath: options.candidate,
    editor: {
      installationRoot,
      executable: identifiedEditor.executable,
      cli: identifiedEditor.cli
    },
    pythonPath: options.python,
    cacheControllerPath: options.cacheController,
    driverDirectory: options.driverDirectory,
    driverVsixPath: options.driverVsix,
    fixturePaths: { csv: options.csv, parquet: options.parquet },
    kernelspecPath: kernel.path,
    templates,
    publicUiCaptures: publicUi.bindings
  });
  const publication = dependencies.writeReceipt(options.preparation, receipt);
  return Object.freeze({
    command: "prepare",
    manifest: planned.output,
    manifestReceipt: planned.receipt,
    preparation: receipt,
    preparationReceipt: publication
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await prepareDataWranglerComparisonStudy(options);
  process.stdout.write(
    canonicalStudyJson({
      command: result.command,
      manifestSha256: digestStudyValue(result.manifest),
      preparationSha256: digestStudyValue(result.preparation)
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArguments as parseDataWranglerComparisonPreparationArguments };
