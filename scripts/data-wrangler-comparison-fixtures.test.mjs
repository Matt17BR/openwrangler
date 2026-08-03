import assert from "node:assert/strict";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
  validateDataWranglerComparisonCanonicalFixtures
} from "./data-wrangler-comparison-fixtures.mjs";

const privateRoot = "/study";
const scratch = "/study/canonical-fixtures-test";
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

function validationInput(value = fixtures) {
  return { pythonPath: "/python", privateRoot, fixtures: value };
}

function receipt(path, suffix = "a") {
  return {
    path,
    sha256: suffix.repeat(64),
    filesystemIdentity: { device: "1", inode: "2", sizeBytes: 3, mtimeNs: "4" }
  };
}

function generatedManifest(suffixes = { csv: "a", parquet: "a" }) {
  return {
    protocol: "openwrangler-installed-performance-fixtures-v1",
    smoke: false,
    generator: { contractVersion: 1, implementation: "polars", implementationVersion: "1.32.3" },
    fixtures: {
      csv: {
        fileName: "100000-50.csv",
        format: "csv",
        rows: 100_000,
        columns: 50,
        columnType: "Int64",
        sha256: suffixes.csv.repeat(64),
        bytes: 3
      },
      parquet: {
        fileName: "1000000-20.parquet",
        format: "parquet",
        rows: 1_000_000,
        columns: 20,
        columnType: "Int64",
        sha256: suffixes.parquet.repeat(64),
        bytes: 3
      }
    }
  };
}

function successfulDependencies(overrides = {}) {
  const manifest = generatedManifest();
  return {
    contractPath: "/repo/fixture_contract.py",
    generatorPath: "/repo/installed_editor_fixtures.py",
    assertPrivateDirectory: () => undefined,
    captureFile: (path) => receipt(path),
    createDirectory: () => undefined,
    createScratch: (prefix) => {
      assert.equal(prefix, "/study/canonical-fixtures-");
      return scratch;
    },
    executeInterpreter: (_python, args) => {
      if (args[0] === "/repo/installed_editor_fixtures.py") {
        assert.deepEqual(args, [
          "/repo/installed_editor_fixtures.py",
          "--output-dir",
          "/study/canonical-fixtures-test/fixtures",
          "--manifest-out",
          "/study/canonical-fixtures-test/manifest.json"
        ]);
        return JSON.stringify(manifest);
      }
      assert.equal(args[0], "-I");
      assert.match(args[2], /assert_fixture_contract/u);
      return JSON.stringify({
        protocol: DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
        contractVersion: 1,
        implementation: "polars",
        implementationVersion: "1.32.3"
      });
    },
    readManifest: () => ({ value: structuredClone(manifest), receipt: receipt(`${scratch}/manifest.json`) }),
    removeScratch: () => undefined,
    setMode: () => undefined,
    ...overrides
  };
}

test("canonical fixture validation regenerates private bytes before accepting caller paths", () => {
  const captured = [];
  const result = validateDataWranglerComparisonCanonicalFixtures(
    validationInput(),
    successfulDependencies({
      captureFile(path) {
        captured.push(path);
        return receipt(path);
      }
    })
  );
  assert.deepEqual(result.toolchain, {
    protocol: DATA_WRANGLER_COMPARISON_FIXTURE_TOOLCHAIN_PROTOCOL,
    contractVersion: 1,
    implementation: "polars",
    implementationVersion: "1.32.3",
    generatorSha256: "a".repeat(64),
    contractSha256: "a".repeat(64)
  });
  assert.deepEqual(
    result.fixtures.map(({ id, format, path, sha256 }) => ({ id, format, path, sha256 })),
    fixtures.map(({ id, format, path }) => ({ id, format, path, sha256: "a".repeat(64) }))
  );
  assert.ok(captured.indexOf(`${scratch}/fixtures/100000-50.csv`) < captured.indexOf("/fixtures/data.csv"));
  assert.ok(captured.indexOf(`${scratch}/fixtures/1000000-20.parquet`) < captured.indexOf("/fixtures/data.parquet"));
});

test("canonical fixture validation rejects a permuted fixture registry before generation", () => {
  let executed = false;
  assert.throws(
    () =>
      validateDataWranglerComparisonCanonicalFixtures(
        validationInput([...fixtures].reverse()),
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
        validationInput(),
        successfulDependencies({
          captureFile(path) {
            if (path === "/fixtures/data.csv") csvReads += 1;
            return receipt(path, path === "/fixtures/data.csv" && csvReads === 2 ? "b" : "a");
          }
        })
      ),
    /changed during validation/u
  );
});

for (const variant of [
  { format: "csv", suffix: "b", label: "alternate CSV newline or encoding layout" },
  { format: "parquet", suffix: "c", label: "alternate Parquet compression or row-group layout" }
]) {
  test(`canonical fixture validation rejects an ${variant.label}`, () => {
    const manifest = generatedManifest({
      csv: variant.format === "csv" ? variant.suffix : "a",
      parquet: variant.format === "parquet" ? variant.suffix : "a"
    });
    let semanticValidationRan = false;
    let removed = false;
    assert.throws(
      () =>
        validateDataWranglerComparisonCanonicalFixtures(
          validationInput(),
          successfulDependencies({
            captureFile(path) {
              const generated = path.startsWith(`${scratch}/fixtures/`);
              const isVariant = path.endsWith(variant.format === "csv" ? ".csv" : ".parquet");
              return receipt(path, generated && isVariant ? variant.suffix : "a");
            },
            executeInterpreter(_python, args) {
              if (args[0] === "/repo/installed_editor_fixtures.py") return JSON.stringify(manifest);
              semanticValidationRan = true;
              throw new Error("Semantic validation must not run for byte-distinct fixtures.");
            },
            readManifest: () => ({ value: structuredClone(manifest), receipt: receipt(`${scratch}/manifest.json`) }),
            removeScratch(path, options) {
              assert.equal(path, scratch);
              assert.deepEqual(options, { recursive: true, force: false });
              removed = true;
            }
          })
        ),
      new RegExp(`canonical ${variant.format} fixture bytes do not match`, "u")
    );
    assert.equal(semanticValidationRan, false);
    assert.equal(removed, true);
  });
}
