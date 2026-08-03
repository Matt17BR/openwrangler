import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDataWranglerPreparationPrivateDirectory,
  captureDataWranglerPreparationFile,
  DATA_WRANGLER_PREPARATION_FILE_LIMITS,
  executeIdentityPinnedPreparationInterpreter,
  readBoundedDataWranglerPreparationJson
} from "./data-wrangler-comparison-preparation.mjs";
import { canonicalStudyJson } from "./data-wrangler-comparison-study.mjs";

export const DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL = "openwrangler-performance-fixture-toolchain-v1";
const INSTALLED_FIXTURE_MANIFEST_PROTOCOL = "openwrangler-installed-performance-fixtures-v1";
const MAX_GENERATED_MANIFEST_BYTES = 64 * 1024;
export const DATA_WRANGLER_COMPARISON_FIXTURE_CONTRACT_PATH = fileURLToPath(
  new URL("../python/benchmarks/fixture_contract.py", import.meta.url)
);
export const DATA_WRANGLER_COMPARISON_FIXTURE_GENERATOR_PATH = fileURLToPath(
  new URL("../python/benchmarks/installed_editor_fixtures.py", import.meta.url)
);

const expected = Object.freeze([
  Object.freeze({ id: "csv-100k-50", format: "csv", rows: 100_000, columns: 50 }),
  Object.freeze({ id: "parquet-1m-20", format: "parquet", rows: 1_000_000, columns: 20 })
]);

function fail(message) {
  throw new TypeError(message);
}

function coreReceipt(receipt) {
  return { sha256: receipt.sha256, filesystemIdentity: structuredClone(receipt.filesystemIdentity) };
}

function sameReceipt(left, right) {
  return canonicalStudyJson(coreReceipt(left)) === canonicalStudyJson(coreReceipt(right));
}

function parseInterpreterJson(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new TypeError(`${label} returned invalid JSON.`, { cause: error });
  }
}

function validateGeneratedManifest(manifest, normalized, canonicalReceipts) {
  if (
    manifest?.protocol !== INSTALLED_FIXTURE_MANIFEST_PROTOCOL ||
    manifest.smoke !== false ||
    manifest.generator?.contractVersion !== 1 ||
    manifest.generator.implementation !== "polars" ||
    typeof manifest.generator.implementationVersion !== "string" ||
    manifest.generator.implementationVersion.length === 0 ||
    manifest.fixtures === null ||
    typeof manifest.fixtures !== "object" ||
    Array.isArray(manifest.fixtures)
  ) {
    fail("Comparison canonical fixture generator returned an invalid manifest.");
  }
  for (const [index, fixture] of normalized.entries()) {
    const entry = manifest.fixtures[fixture.format];
    const receipt = canonicalReceipts[index];
    if (
      entry?.fileName !== basename(receipt.path) ||
      entry.format !== fixture.format ||
      entry.rows !== fixture.rows ||
      entry.columns !== fixture.columns ||
      entry.columnType !== "Int64" ||
      entry.sha256 !== receipt.sha256 ||
      entry.bytes !== receipt.filesystemIdentity.sizeBytes
    ) {
      fail(`Comparison generated ${fixture.format} fixture does not match its canonical manifest.`);
    }
  }
  return manifest.generator;
}

export function validateDataWranglerComparisonCanonicalFixtures(
  { pythonPath, fixtures, privateRoot },
  {
    assertPrivateDirectory = assertDataWranglerPreparationPrivateDirectory,
    captureFile = captureDataWranglerPreparationFile,
    createDirectory = mkdirSync,
    createScratch = mkdtempSync,
    executeInterpreter = executeIdentityPinnedPreparationInterpreter,
    contractPath = DATA_WRANGLER_COMPARISON_FIXTURE_CONTRACT_PATH,
    generatorPath = DATA_WRANGLER_COMPARISON_FIXTURE_GENERATOR_PATH,
    readManifest = readBoundedDataWranglerPreparationJson,
    removeScratch = rmSync,
    setMode = chmodSync
  } = {}
) {
  if (!Array.isArray(fixtures) || fixtures.length !== expected.length) {
    fail("Comparison preparation requires the canonical CSV and Parquet fixtures.");
  }
  const normalized = fixtures.map((fixture, index) => {
    const shape = expected[index];
    if (
      fixture?.id !== shape.id ||
      fixture.format !== shape.format ||
      fixture.rows !== shape.rows ||
      fixture.columns !== shape.columns ||
      typeof fixture.path !== "string"
    ) {
      fail("Comparison preparation fixture order, identity, format, or shape is not canonical.");
    }
    return { ...shape, path: fixture.path };
  });
  assertPrivateDirectory(privateRoot, "Comparison fixture validation root");
  const contractBefore = captureFile(contractPath, "Comparison fixture contract");
  const generatorBefore = captureFile(generatorPath, "Comparison fixture generator");
  let scratch;
  try {
    scratch = createScratch(resolve(privateRoot, "canonical-fixtures-"));
    setMode(scratch, 0o700);
    assertPrivateDirectory(scratch, "Comparison generated fixture scratch");
    const outputDirectory = resolve(scratch, "fixtures");
    const manifestPath = resolve(scratch, "manifest.json");
    createDirectory(outputDirectory, { recursive: false, mode: 0o700 });
    setMode(outputDirectory, 0o700);
    assertPrivateDirectory(outputDirectory, "Comparison generated fixture output");

    let generatedOutput;
    try {
      generatedOutput = parseInterpreterJson(
        executeInterpreter(pythonPath, [
          generatorPath,
          "--output-dir",
          outputDirectory,
          "--manifest-out",
          manifestPath
        ]),
        "Comparison canonical fixture generator"
      );
    } catch (error) {
      throw new TypeError("Comparison canonical fixture generation failed.", { cause: error });
    }
    const generatedManifest = readManifest(
      manifestPath,
      "Comparison generated fixture manifest",
      MAX_GENERATED_MANIFEST_BYTES
    );
    if (canonicalStudyJson(generatedOutput) !== canonicalStudyJson(generatedManifest.value)) {
      fail("Comparison canonical fixture generator stdout and manifest differ.");
    }
    const canonicalReceipts = normalized.map((fixture) =>
      captureFile(
        resolve(outputDirectory, `${fixture.rows}-${fixture.columns}.${fixture.format}`),
        `Comparison generated ${fixture.format} fixture`,
        { maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.fixture }
      )
    );
    const generator = validateGeneratedManifest(generatedManifest.value, normalized, canonicalReceipts);

    // Only after an empty private destination has regenerated the exact checked-in
    // layout do caller-supplied fixture paths become eligible for a preparation receipt.
    const fixturesBefore = normalized.map((fixture, index) => {
      const receipt = captureFile(fixture.path, `Comparison canonical ${fixture.format} fixture`, {
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.fixture
      });
      if (receipt.sha256 !== canonicalReceipts[index].sha256) {
        fail(`Comparison canonical ${fixture.format} fixture bytes do not match the checked-in generator.`);
      }
      return receipt;
    });

    const source = [
      "import importlib.util, json, pathlib, sys",
      `contract_path = pathlib.Path(${JSON.stringify(contractPath)})`,
      "spec = importlib.util.spec_from_file_location('openwrangler_fixture_contract', contract_path)",
      "module = importlib.util.module_from_spec(spec)",
      "sys.modules[spec.name] = module",
      "spec.loader.exec_module(module)",
      `fixtures = ${JSON.stringify(normalized)}`,
      "for fixture in fixtures:",
      "    module.assert_fixture_contract(pathlib.Path(fixture['path']), module.FixtureSpec(fixture['format'], fixture['rows'], fixture['columns']))",
      `print(json.dumps({'protocol': ${JSON.stringify(DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL)}, 'contractVersion': 1, 'implementation': 'polars', 'implementationVersion': module.pl.__version__}, sort_keys=True))`
    ].join("\n");
    let result;
    try {
      result = parseInterpreterJson(
        executeInterpreter(pythonPath, ["-I", "-c", source]),
        "Comparison canonical fixture validation"
      );
    } catch (error) {
      throw new TypeError("Comparison canonical fixture validation failed.", { cause: error });
    }
    const contractAfter = captureFile(contractPath, "Comparison fixture contract");
    const generatorAfter = captureFile(generatorPath, "Comparison fixture generator");
    const canonicalAfter = normalized.map((fixture) =>
      captureFile(
        resolve(outputDirectory, `${fixture.rows}-${fixture.columns}.${fixture.format}`),
        `Comparison generated ${fixture.format} fixture`,
        { maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.fixture }
      )
    );
    const fixturesAfter = normalized.map((fixture) =>
      captureFile(fixture.path, `Comparison canonical ${fixture.format} fixture`, {
        maximumBytes: DATA_WRANGLER_PREPARATION_FILE_LIMITS.fixture
      })
    );
    if (
      !sameReceipt(contractBefore, contractAfter) ||
      !sameReceipt(generatorBefore, generatorAfter) ||
      canonicalReceipts.some((receipt, index) => !sameReceipt(receipt, canonicalAfter[index])) ||
      fixturesBefore.some((receipt, index) => !sameReceipt(receipt, fixturesAfter[index]))
    ) {
      fail(
        "Comparison fixture contract, generator, generated fixture, or canonical fixture changed during validation."
      );
    }
    if (
      result?.protocol !== DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL ||
      result.contractVersion !== 1 ||
      result.implementation !== "polars" ||
      result.implementationVersion !== generator.implementationVersion
    ) {
      fail("Comparison canonical fixture validator returned an invalid toolchain receipt.");
    }
    return Object.freeze({
      toolchain: Object.freeze({
        protocol: result.protocol,
        contractVersion: result.contractVersion,
        implementation: result.implementation,
        implementationVersion: result.implementationVersion,
        generatorSha256: generatorBefore.sha256,
        contractSha256: contractBefore.sha256
      }),
      fixtures: Object.freeze(
        normalized.map((fixture, index) => Object.freeze({ ...fixture, ...fixturesAfter[index] }))
      )
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Comparison canonical fixture validation failed.", { cause: error });
  } finally {
    if (scratch !== undefined) removeScratch(scratch, { recursive: true, force: false });
  }
}
