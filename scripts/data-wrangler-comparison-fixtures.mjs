import { fileURLToPath } from "node:url";
import {
  captureDataWranglerPreparationFile,
  executeIdentityPinnedPreparationInterpreter
} from "./data-wrangler-comparison-preparation.mjs";
import { canonicalStudyJson } from "./data-wrangler-comparison-study.mjs";

export const DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL = "openwrangler-performance-fixture-toolchain-v1";
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

export function validateDataWranglerComparisonCanonicalFixtures(
  { pythonPath, fixtures },
  {
    captureFile = captureDataWranglerPreparationFile,
    executeInterpreter = executeIdentityPinnedPreparationInterpreter,
    contractPath = DATA_WRANGLER_COMPARISON_FIXTURE_CONTRACT_PATH,
    generatorPath = DATA_WRANGLER_COMPARISON_FIXTURE_GENERATOR_PATH
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
  const contractBefore = captureFile(contractPath, "Comparison fixture contract");
  const generatorBefore = captureFile(generatorPath, "Comparison fixture generator");
  const fixturesBefore = normalized.map((fixture) =>
    captureFile(fixture.path, `Comparison canonical ${fixture.format} fixture`)
  );
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
    result = JSON.parse(executeInterpreter(pythonPath, ["-I", "-c", source]));
  } catch (error) {
    throw new TypeError("Comparison canonical fixture validation failed.", { cause: error });
  }
  const contractAfter = captureFile(contractPath, "Comparison fixture contract");
  const generatorAfter = captureFile(generatorPath, "Comparison fixture generator");
  const fixturesAfter = normalized.map((fixture) =>
    captureFile(fixture.path, `Comparison canonical ${fixture.format} fixture`)
  );
  if (
    !sameReceipt(contractBefore, contractAfter) ||
    !sameReceipt(generatorBefore, generatorAfter) ||
    fixturesBefore.some((receipt, index) => !sameReceipt(receipt, fixturesAfter[index]))
  ) {
    fail("Comparison fixture contract, generator, or canonical fixture changed during validation.");
  }
  if (
    result?.protocol !== DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL ||
    result.contractVersion !== 1 ||
    result.implementation !== "polars" ||
    typeof result.implementationVersion !== "string" ||
    result.implementationVersion.length === 0
  ) {
    fail("Comparison canonical fixture validator returned an invalid toolchain receipt.");
  }
  return Object.freeze({
    protocol: result.protocol,
    contractVersion: result.contractVersion,
    implementation: result.implementation,
    implementationVersion: result.implementationVersion,
    generatorSha256: generatorBefore.sha256,
    contractSha256: contractBefore.sha256
  });
}
