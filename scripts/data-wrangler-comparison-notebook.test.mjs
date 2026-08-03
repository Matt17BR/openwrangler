import assert from "node:assert/strict";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import {
  DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL,
  DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_MARKER,
  DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_PROTOCOL,
  DATA_WRANGLER_COMPARISON_SOURCE_ENVIRONMENT_VARIABLE,
  buildDataWranglerComparisonNotebook,
  serializeDataWranglerComparisonNotebook,
  writeDataWranglerComparisonNotebook
} from "./data-wrangler-comparison-notebook.mjs";

const FORMATS = Object.freeze({
  csv: Object.freeze({ id: "csv-100k-50", format: "csv", rows: 100_000, columns: 50, sha256: "a".repeat(64) }),
  parquet: Object.freeze({
    id: "parquet-1m-20",
    format: "parquet",
    rows: 1_000_000,
    columns: 20,
    sha256: "b".repeat(64)
  })
});
const KERNEL = Object.freeze({
  name: "dataframe-comparison-study-cpython-312-trial",
  displayName: "Dataframe comparison study CPython 3.12 (private trial)"
});
const SOURCE_RECEIPT = Object.freeze({
  sha256: "a".repeat(64),
  filesystemIdentity: Object.freeze({
    device: "2049",
    inode: "3001",
    sizeBytes: 1_000_000,
    mtimeNs: "1754100000000000000"
  })
});

function readPinnedNotebook(path) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(descriptor, { bigint: true });
    const payload = readFileSync(descriptor, "utf8");
    const after = fstatSync(descriptor, { bigint: true });
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
    return Object.freeze({ mode: Number(before.mode & 0o777n), payload });
  } finally {
    closeSync(descriptor);
  }
}

function options(engine, format, kind) {
  return {
    engine,
    format,
    kind,
    fixture: FORMATS[format],
    kernel: KERNEL,
    sourceReceipt: { ...SOURCE_RECEIPT, sha256: FORMATS[format].sha256 }
  };
}

function cellSource(notebook, tag) {
  const cell = notebook.cells.find((candidate) => candidate.metadata?.tags?.includes(tag));
  assert.ok(cell, `missing ${tag} cell`);
  return cell.source.join("\n");
}

test("the eight comparison notebooks are deterministic, path-free, and engine-native", () => {
  for (const engine of ["pandas", "polars"]) {
    for (const format of ["csv", "parquet"]) {
      for (const kind of ["warm", "cold"]) {
        const configuration = options(engine, format, kind);
        const first = buildDataWranglerComparisonNotebook(configuration);
        const second = buildDataWranglerComparisonNotebook(configuration);
        assert.deepEqual(first, second);
        assert.equal(first.nbformat, 4);
        assert.equal(first.nbformat_minor, 5);
        assert.equal(first.metadata.openWranglerStudy.protocol, DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL);
        assert.deepEqual(first.metadata.openWranglerStudy.kernel, KERNEL);
        assert.deepEqual(first.metadata.openWranglerStudy.sourceReceipt, configuration.sourceReceipt);
        assert.equal(first.metadata.kernelspec.name, KERNEL.name);
        assert.equal(first.metadata.kernelspec.display_name, KERNEL.displayName);
        assert.equal(
          first.metadata.openWranglerStudy.sourceEnvironmentVariable,
          DATA_WRANGLER_COMPARISON_SOURCE_ENVIRONMENT_VARIABLE
        );
        assert.equal(
          first.cells.every((cell) => cell.cell_type !== "code" || cell.outputs.length === 0),
          true
        );

        const serialized = serializeDataWranglerComparisonNotebook(configuration);
        assert.doesNotMatch(serialized, /(?:^|["\s])\/(?:home|tmp|run|var)\//u);
        assert.doesNotMatch(serialized, /to_pandas|toPandas|from_pandas|from_arrow|pyarrow\.Table/u);
        const setup = cellSource(first, "ow-study-setup");
        if (engine === "pandas" && format === "csv") assert.match(setup, /read_csv\(source_path, dtype="int64"\)/u);
        if (engine === "pandas" && format === "parquet") assert.match(setup, /read_parquet\(source_path\)/u);
        if (engine === "polars" && format === "csv") assert.match(setup, /schema_overrides/u);
        if (engine === "polars" && format === "parquet") assert.match(setup, /read_parquet\(source_path\)/u);
      }
    }
  }
});

test("warm measured cells only return the preloaded object and prove its identity before and after timing", () => {
  const notebook = buildDataWranglerComparisonNotebook(options("pandas", "csv", "warm"));
  assert.equal(cellSource(notebook, "ow-study-measured"), "study_frame");
  const setup = cellSource(notebook, "ow-study-setup");
  assert.match(setup, /study_frame = _ow_load_study_frame\(\)/u);
  assert.match(setup, /_ow_study_frame_object_token = id\(study_frame\)/u);
  assert.match(cellSource(notebook, "ow-study-before-timing"), /before-timing", True/u);
  assert.match(cellSource(notebook, "ow-study-after-workbench"), /after-workbench", True/u);
});

test("cold measured cells load, assign, and return one native study_frame", () => {
  for (const engine of ["pandas", "polars"]) {
    for (const format of ["csv", "parquet"]) {
      const notebook = buildDataWranglerComparisonNotebook(options(engine, format, "cold"));
      assert.equal(cellSource(notebook, "ow-study-measured"), "study_frame = _ow_load_study_frame()\nstudy_frame");
      const setup = cellSource(notebook, "ow-study-setup");
      assert.doesNotMatch(setup, /^study_frame\s*=/mu);
      assert.match(cellSource(notebook, "ow-study-before-timing"), /_ow_validation_frame/u);
      assert.match(cellSource(notebook, "ow-study-after-workbench"), /after-workbench", False/u);
    }
  }
});

test("verification receipts retain observed source facts and only the three registered sentinel values", () => {
  const notebook = buildDataWranglerComparisonNotebook(options("polars", "parquet", "warm"));
  const source = cellSource(notebook, "ow-study-setup");
  for (const check of [
    "classMatched",
    "configuredKernel",
    "actualClass",
    "shape",
    "columns",
    "dtypes",
    "integerDtypeSemantic",
    "sentinelRows",
    "shapeMatched",
    "columnsMatched",
    "integerDtypeMatched",
    "sentinelsMatched",
    "objectTokenContinuous",
    "pythonImplementation",
    "pythonVersion",
    "observedSource",
    "filesystemIdentity"
  ]) {
    assert.match(source, new RegExp(`"${check}"`, "u"));
  }
  assert.match(source, /actual_type is _ow_engine\.DataFrame/u);
  assert.match(source, /actual_shape == \[_OW_ROWS, _OW_COLUMN_COUNT\]/u);
  assert.match(source, /actual_columns == list\(_OW_COLUMNS\)/u);
  assert.match(source, /actual_dtypes = \[str\(dtype\) for dtype in frame\.dtypes\]/u);
  assert.match(source, /_OW_SENTINEL_ROWS = \(0, 1, _OW_ROWS \/\/ 2, _OW_ROWS - 1\)/u);
  assert.match(source, /value_at\(row, column\) == row \+ column/u);
  assert.match(source, /"rowIndex": 1, "column": actual_columns\[1\], "value": int\(value_at\(1, 1\)\)/u);
  assert.match(source, /source_sha256 = digest\.hexdigest\(\)/u);
  assert.match(source, /source_stat_before = _ow_os\.fstat\(source\.fileno\(\)\)/u);
  assert.match(source, /source_stat_after = _ow_os\.fstat\(source\.fileno\(\)\)/u);
  assert.match(source, /source_receipt != _OW_EXPECTED_SOURCE_RECEIPT/u);
  assert.match(source, /"rowDataIncluded": False/u);
  assert.match(source, /_ow_platform\.python_implementation\(\)/u);
  assert.match(source, /_ow_python_implementation != "CPython"/u);
  assert.match(source, /not _ow_python_version\.startswith\("3\.12\."\)/u);
  assert.match(source, new RegExp(JSON.stringify(DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_PROTOCOL), "u"));
  assert.match(source, new RegExp(DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_MARKER, "u"));
  for (const tag of ["ow-study-before-timing", "ow-study-after-workbench"]) {
    assert.match(cellSource(notebook, tag), /_ow_emit_verification/u);
  }
  assert.doesNotMatch(source, /to_dict|to_dicts|to_json|print\(frame|display\(frame/u);
});

test("the notebook accepts no source path and resolves only the generic private environment input", () => {
  const sourceCanary = "/home/private-study/fixture.csv";
  const configuration = options("pandas", "csv", "warm");
  const serialized = serializeDataWranglerComparisonNotebook(configuration);
  assert.equal(serialized.includes(sourceCanary), false);
  assert.match(serialized, /_ow_os\.environ\.pop\(_OW_SOURCE_ENV, None\)/u);
  assert.doesNotMatch(serialized, /(?:pathlib\.)?Path\(|file:\/\//u);
  assert.throws(
    () => buildDataWranglerComparisonNotebook({ ...configuration, sourcePath: sourceCanary }),
    /missing or unknown fields/u
  );
});

test("the notebook rejects missing, malformed, and legacy source bindings", () => {
  const configuration = options("pandas", "csv", "warm");
  assert.throws(
    () => buildDataWranglerComparisonNotebook({ ...configuration, sourceReceipt: undefined }),
    /source receipt must be an object/u
  );
  assert.throws(
    () =>
      buildDataWranglerComparisonNotebook({
        ...configuration,
        sourceReceipt: { ...configuration.sourceReceipt, sha256: "b" }
      }),
    /source receipt is invalid/u
  );
  const notebook = buildDataWranglerComparisonNotebook(configuration);
  notebook.metadata.openWranglerStudy.protocol = "openwrangler-data-wrangler-notebook-v1";
  assert.notEqual(notebook.metadata.openWranglerStudy.protocol, DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL);
});

test("the writer creates one exclusive 0600 notebook and retains no destination path in it", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "ow-comparison-notebook-"));
  try {
    const path = resolve(directory, "pandas-csv-warm.ipynb");
    const receipt = writeDataWranglerComparisonNotebook(path, options("pandas", "csv", "warm"));
    assert.equal(receipt.path, path);
    assert.equal(receipt.mode, "0600");
    const { mode, payload } = readPinnedNotebook(path);
    assert.equal(mode, 0o600);
    assert.equal(payload.includes(path), false);
    assert.deepEqual(JSON.parse(payload), buildDataWranglerComparisonNotebook(options("pandas", "csv", "warm")));
    assert.deepEqual(readdirSync(directory), ["pandas-csv-warm.ipynb"]);
    assert.throws(
      () => writeDataWranglerComparisonNotebook(path, options("pandas", "csv", "warm")),
      /Could not write the private comparison notebook/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("notebook construction rejects drift from the registered release-sized fixtures", () => {
  assert.throws(
    () =>
      buildDataWranglerComparisonNotebook({
        ...options("pandas", "csv", "warm"),
        fixture: { ...FORMATS.csv, rows: 99_999 }
      }),
    /identity, format, or shape/u
  );
  assert.throws(
    () =>
      buildDataWranglerComparisonNotebook({
        ...options("polars", "parquet", "cold"),
        fixture: { ...FORMATS.parquet, sha256: "not-a-digest" }
      }),
    /SHA-256/u
  );
  assert.throws(
    () =>
      buildDataWranglerComparisonNotebook({
        ...options("pandas", "csv", "warm"),
        kernel: { ...KERNEL, name: "python3" }
      }),
    /trial-private/u
  );
  assert.throws(
    () =>
      buildDataWranglerComparisonNotebook({
        ...options("pandas", "csv", "warm"),
        kernel: { ...KERNEL, displayName: "/private/kernel/path" }
      }),
    /path-free picker label/u
  );
});
