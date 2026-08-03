import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
  validateDataWranglerComparisonCanonicalFixtures
} from "./data-wrangler-comparison-fixtures.mjs";

const fixtures = Object.freeze([
  Object.freeze({ id: "csv-100k-50", format: "csv", rows: 100_000, columns: 50, path: "/fixtures/data.csv" }),
  Object.freeze({
    id: "parquet-1m-20",
    format: "parquet",
    rows: 1_000_000,
    columns: 20,
    path: "/fixtures/data.parquet"
  })
]);

function receipt(path, suffix = "a") {
  return {
    path,
    sha256: suffix.repeat(64),
    filesystemIdentity: { device: "1", inode: "2", sizeBytes: 3, mtimeNs: "4" }
  };
}

function successfulDependencies(overrides = {}) {
  return {
    contractPath: "/repo/fixture_contract.py",
    generatorPath: "/repo/installed_editor_fixtures.py",
    captureFile: (path) => receipt(path),
    executeInterpreter: (_python, args) => {
      assert.equal(args[0], "-I");
      assert.match(args[2], /assert_fixture_contract/u);
      return JSON.stringify({
        protocol: DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
        contractVersion: 1,
        implementation: "polars",
        implementationVersion: "1.32.3"
      });
    },
    ...overrides
  };
}

test("canonical fixture validation binds the checked-in generator and contract", () => {
  const result = validateDataWranglerComparisonCanonicalFixtures(
    { pythonPath: "/python", fixtures },
    successfulDependencies()
  );
  assert.deepEqual(result, {
    protocol: DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
    contractVersion: 1,
    implementation: "polars",
    implementationVersion: "1.32.3",
    generatorSha256: "a".repeat(64),
    contractSha256: "a".repeat(64)
  });
});

test("canonical fixture validation rejects a permuted fixture registry before execution", () => {
  let executed = false;
  assert.throws(
    () =>
      validateDataWranglerComparisonCanonicalFixtures(
        { pythonPath: "/python", fixtures: [...fixtures].reverse() },
        successfulDependencies({
          executeInterpreter: () => {
            executed = true;
          }
        })
      ),
    /order, identity, format, or shape is not canonical/u
  );
  assert.equal(executed, false);
});

test("canonical fixture validation rejects fixture mutation across the Python contract check", () => {
  let csvReads = 0;
  assert.throws(
    () =>
      validateDataWranglerComparisonCanonicalFixtures(
        { pythonPath: "/python", fixtures },
        successfulDependencies({
          captureFile(path) {
            if (path.endsWith("data.csv")) csvReads += 1;
            return receipt(path, path.endsWith("data.csv") && csvReads === 2 ? "b" : "a");
          }
        })
      ),
    /changed during validation/u
  );
});
