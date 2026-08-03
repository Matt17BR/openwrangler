import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

export const DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL = "openwrangler-data-wrangler-notebook-v2";
export const DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_PROTOCOL =
  "openwrangler-data-wrangler-notebook-verification-v2";
export const DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_MARKER = "OPENWRANGLER_STUDY_VERIFICATION:";
export const DATA_WRANGLER_COMPARISON_SOURCE_ENVIRONMENT_VARIABLE = "OPEN_WRANGLER_STUDY_SOURCE";

const SHA256 = /^[0-9a-f]{64}$/u;
const NOTEBOOK_MODE = 0o600;
const FIXTURES = Object.freeze({
  csv: Object.freeze({ id: "csv-100k-50", rows: 100_000, columns: 50 }),
  parquet: Object.freeze({ id: "parquet-1m-20", rows: 1_000_000, columns: 20 })
});

function fail(message) {
  throw new TypeError(message);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has missing or unknown fields.`);
  }
}

function validateOptions(options) {
  exactKeys(options, ["engine", "format", "kind", "fixture", "kernel", "sourceReceipt"], "Comparison notebook options");
  if (!["pandas", "polars"].includes(options.engine)) {
    fail("Comparison notebook engine must be pandas or polars.");
  }
  if (!["csv", "parquet"].includes(options.format)) {
    fail("Comparison notebook format must be csv or parquet.");
  }
  if (!["warm", "cold"].includes(options.kind)) {
    fail("Comparison notebook kind must be warm or cold.");
  }
  exactKeys(options.fixture, ["id", "format", "rows", "columns", "sha256"], "Comparison fixture");
  const expected = FIXTURES[options.format];
  if (
    options.fixture.id !== expected.id ||
    options.fixture.format !== options.format ||
    options.fixture.rows !== expected.rows ||
    options.fixture.columns !== expected.columns
  ) {
    fail("Comparison fixture identity, format, or shape does not match the registered study cell.");
  }
  if (typeof options.fixture.sha256 !== "string" || !SHA256.test(options.fixture.sha256)) {
    fail("Comparison fixture SHA-256 is invalid.");
  }
  validateKernel(options.kernel);
  validateSourceReceipt(options.sourceReceipt);
  return options;
}

function validateSourceReceipt(sourceReceipt) {
  exactKeys(sourceReceipt, ["sha256", "filesystemIdentity"], "Comparison notebook source receipt");
  exactKeys(
    sourceReceipt.filesystemIdentity,
    ["device", "inode", "sizeBytes", "mtimeNs"],
    "Comparison notebook source filesystem identity"
  );
  const identity = sourceReceipt.filesystemIdentity;
  if (
    typeof sourceReceipt.sha256 !== "string" ||
    !SHA256.test(sourceReceipt.sha256) ||
    typeof identity.device !== "string" ||
    !/^\d+$/u.test(identity.device) ||
    typeof identity.inode !== "string" ||
    !/^\d+$/u.test(identity.inode) ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes <= 0 ||
    typeof identity.mtimeNs !== "string" ||
    !/^\d+$/u.test(identity.mtimeNs)
  ) {
    fail("Comparison notebook source receipt is invalid.");
  }
}

function validateKernel(kernel) {
  exactKeys(kernel, ["name", "displayName"], "Comparison notebook kernel");
  if (typeof kernel.name !== "string" || !/^dataframe-comparison-study-[a-z0-9][a-z0-9._-]{0,95}$/u.test(kernel.name)) {
    fail("Comparison notebook kernel name must identify one product-neutral, trial-private kernelspec.");
  }
  if (
    typeof kernel.displayName !== "string" ||
    kernel.displayName.length === 0 ||
    kernel.displayName.length > 128 ||
    /[\0\r\n/\\]/u.test(kernel.displayName)
  ) {
    fail("Comparison notebook kernel display name must be one bounded path-free picker label.");
  }
}

function pythonLiteral(value) {
  return JSON.stringify(value);
}

function sourceLines(source) {
  return source.trimEnd().split("\n");
}

function codeCell(id, tags, source) {
  return {
    cell_type: "code",
    execution_count: null,
    id,
    metadata: { tags },
    outputs: [],
    source: sourceLines(source)
  };
}

function markdownCell(id, source) {
  return {
    cell_type: "markdown",
    id,
    metadata: {},
    source: sourceLines(source)
  };
}

function loaderExpression(engine, format) {
  if (engine === "pandas") {
    return format === "csv"
      ? '_ow_engine.read_csv(source_path, dtype="int64")'
      : "_ow_engine.read_parquet(source_path)";
  }
  return format === "csv"
    ? "_ow_engine.read_csv(source_path, schema_overrides={name: _ow_engine.Int64 for name in _OW_COLUMNS})"
    : "_ow_engine.read_parquet(source_path)";
}

function setupSource({ engine, format, kind, fixture, kernel, sourceReceipt }) {
  const moduleName = engine === "pandas" ? "pandas" : "polars";
  const expectedModule = engine === "pandas" ? "pandas.core.frame" : "polars.dataframe.frame";
  const exactDtype = engine === "pandas" ? "int64" : "Int64";
  const warmSetup =
    kind === "warm"
      ? ["study_frame = _ow_load_study_frame()", "_ow_study_frame_object_token = id(study_frame)"].join("\n")
      : "";
  return `import hashlib as _ow_hashlib
import json as _ow_json
import os as _ow_os
import platform as _ow_platform
import ${moduleName} as _ow_engine

_OW_NOTEBOOK_PROTOCOL = ${pythonLiteral(DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL)}
_OW_VERIFICATION_PROTOCOL = ${pythonLiteral(DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_PROTOCOL)}
_OW_VERIFICATION_MARKER = ${pythonLiteral(DATA_WRANGLER_COMPARISON_NOTEBOOK_VERIFICATION_MARKER)}
_OW_SOURCE_ENV = ${pythonLiteral(DATA_WRANGLER_COMPARISON_SOURCE_ENVIRONMENT_VARIABLE)}
_OW_FIXTURE_ID = ${pythonLiteral(fixture.id)}
_OW_FIXTURE_SHA256 = ${pythonLiteral(fixture.sha256)}
_OW_EXPECTED_SOURCE_RECEIPT = ${pythonLiteral(sourceReceipt)}
_OW_ENGINE = ${pythonLiteral(engine)}
_OW_KERNEL_NAME = ${pythonLiteral(kernel.name)}
_OW_KERNEL_DISPLAY_NAME = ${pythonLiteral(kernel.displayName)}
_OW_ROWS = ${fixture.rows}
_OW_COLUMN_COUNT = ${fixture.columns}
_OW_COLUMNS = tuple(f"c{index:02d}" for index in range(_OW_COLUMN_COUNT))
_OW_SENTINEL_ROWS = (0, 1, _OW_ROWS // 2, _OW_ROWS - 1)
_OW_EXPECTED_MODULE = ${pythonLiteral(expectedModule)}
_OW_EXACT_DTYPE = ${pythonLiteral(exactDtype)}
_ow_study_source_path = _ow_os.environ.pop(_OW_SOURCE_ENV, None)
_ow_python_implementation = _ow_platform.python_implementation()
_ow_python_version = _ow_platform.python_version()
_ow_source_file_receipt = None

def _ow_setup_failure():
    raise AssertionError("The registered study source did not pass notebook setup.") from None

def _ow_validate_study_source():
    global _ow_source_file_receipt
    if _ow_python_implementation != "CPython" or not _ow_python_version.startswith("3.12."):
        _ow_setup_failure()
    if not isinstance(_ow_study_source_path, str) or not _ow_study_source_path:
        _ow_setup_failure()
    digest = _ow_hashlib.sha256()
    try:
        with open(_ow_study_source_path, "rb") as source:
            source_stat_before = _ow_os.fstat(source.fileno())
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
            source_stat_after = _ow_os.fstat(source.fileno())
    except Exception:
        _ow_setup_failure()
    source_sha256 = digest.hexdigest()
    source_receipt = {
        "sha256": source_sha256,
        "filesystemIdentity": {
            "device": str(source_stat_before.st_dev),
            "inode": str(source_stat_before.st_ino),
            "sizeBytes": int(source_stat_before.st_size),
            "mtimeNs": str(source_stat_before.st_mtime_ns),
        },
    }
    stable_source = (
        source_stat_before.st_dev == source_stat_after.st_dev
        and source_stat_before.st_ino == source_stat_after.st_ino
        and source_stat_before.st_size == source_stat_after.st_size
        and source_stat_before.st_mtime_ns == source_stat_after.st_mtime_ns
    )
    if (
        not stable_source
        or source_sha256 != _OW_FIXTURE_SHA256
        or source_receipt != _OW_EXPECTED_SOURCE_RECEIPT
    ):
        _ow_setup_failure()
    _ow_source_file_receipt = source_receipt

def _ow_read_study_source():
    source_path = _ow_study_source_path
    try:
        frame = ${loaderExpression(engine, format)}
    except Exception:
        _ow_setup_failure()
    return frame

def _ow_load_study_frame():
    global _ow_study_source_path
    try:
        return _ow_read_study_source()
    finally:
        _ow_study_source_path = None

def _ow_verify_study_frame(frame, phase, require_object_token):
    actual_type = type(frame)
    actual_class = {"module": actual_type.__module__, "name": actual_type.__name__}
    actual_shape = [int(dimension) for dimension in frame.shape]
    actual_columns = list(frame.columns)
    class_matched = actual_type is _ow_engine.DataFrame and actual_type.__module__ == _OW_EXPECTED_MODULE
    shape_matched = actual_shape == [_OW_ROWS, _OW_COLUMN_COUNT]
    columns_matched = actual_columns == list(_OW_COLUMNS)
    if _OW_ENGINE == "pandas":
        actual_dtypes = [str(dtype) for dtype in frame.dtypes]
        value_at = lambda row, column: frame.iloc[row, column]
    else:
        actual_dtypes = [str(dtype) for dtype in frame.dtypes]
        value_at = lambda row, column: frame[row, column]
    integer_dtype_matched = all(dtype == _OW_EXACT_DTYPE for dtype in actual_dtypes)
    sentinels_matched = all(
        value_at(row, column) == row + column
        for row in _OW_SENTINEL_ROWS
        for column in range(_OW_COLUMN_COUNT)
    )
    object_token_continuous = (
        id(frame) == _ow_study_frame_object_token if require_object_token else None
    )
    observed_schema = [
        {"name": name, "dtype": "int64"}
        for name, dtype in zip(actual_columns, actual_dtypes, strict=True)
        if dtype == _OW_EXACT_DTYPE
    ]
    observed_sentinels = [
        {"rowIndex": 0, "column": actual_columns[0], "value": int(value_at(0, 0))},
        {"rowIndex": 1, "column": actual_columns[1], "value": int(value_at(1, 1))},
        {
            "rowIndex": _OW_ROWS - 1,
            "column": actual_columns[-1],
            "value": int(value_at(_OW_ROWS - 1, _OW_COLUMN_COUNT - 1)),
        },
    ]
    checks = (
        class_matched,
        shape_matched,
        columns_matched,
        integer_dtype_matched,
        sentinels_matched,
        object_token_continuous is not False,
    )
    if not all(checks):
        raise AssertionError("The study dataframe did not match its registered contract.") from None
    return {
        "protocol": _OW_VERIFICATION_PROTOCOL,
        "phase": phase,
        "fixtureId": _OW_FIXTURE_ID,
        "fixtureSha256": _OW_FIXTURE_SHA256,
        "engine": _OW_ENGINE,
        "configuredKernel": {"name": _OW_KERNEL_NAME, "displayName": _OW_KERNEL_DISPLAY_NAME},
        "pythonImplementation": _ow_python_implementation,
        "pythonVersion": _ow_python_version,
        "actualClass": actual_class,
        "shape": actual_shape,
        "columns": actual_columns,
        "dtypes": actual_dtypes,
        "integerDtypeSemantic": "signed-64-bit",
        "sentinelRows": list(_OW_SENTINEL_ROWS),
        "classMatched": class_matched,
        "shapeMatched": shape_matched,
        "columnsMatched": columns_matched,
        "integerDtypeMatched": integer_dtype_matched,
        "sentinelsMatched": sentinels_matched,
        "objectTokenContinuous": object_token_continuous,
        "rowDataIncluded": False,
        "observedSource": {
            "file": dict(_ow_source_file_receipt),
            "semanticClass": "dataframe",
            "rowCount": actual_shape[0],
            "columnCount": actual_shape[1],
            "schema": observed_schema,
            "sentinels": observed_sentinels,
        },
    }

def _ow_emit_verification(frame, phase, require_object_token):
    receipt = _ow_verify_study_frame(frame, phase, require_object_token)
    print(_OW_VERIFICATION_MARKER + _ow_json.dumps(receipt, sort_keys=True, separators=(",", ":")))

_ow_validate_study_source()
${warmSetup}`;
}

function beforeVerificationSource(kind) {
  if (kind === "warm") {
    return `_ow_emit_verification(study_frame, "before-timing", True)`;
  }
  return `_ow_validation_frame = _ow_read_study_source()
try:
    _ow_before_receipt = _ow_verify_study_frame(_ow_validation_frame, "before-timing", False)
finally:
    del _ow_validation_frame
print(_OW_VERIFICATION_MARKER + _ow_json.dumps(_ow_before_receipt, sort_keys=True, separators=(",", ":")))`;
}

function measuredSource(kind) {
  if (kind === "warm") {
    return "study_frame";
  }
  return `study_frame = _ow_load_study_frame()
study_frame`;
}

function afterVerificationSource(kind) {
  return `_ow_emit_verification(study_frame, "after-workbench", ${kind === "warm" ? "True" : "False"})`;
}

export function buildDataWranglerComparisonNotebook(options) {
  const validated = validateOptions(options);
  const { engine, format, kind, fixture, kernel } = validated;
  const cellPrefix = `${engine}-${format}-${kind}`;
  return {
    cells: [
      markdownCell(
        `${cellPrefix}-notice`,
        "# Data Wrangler comparison trial\n\nThis private notebook contains deterministic synthetic study setup. Its verification cells report contract checks without row data or source paths."
      ),
      codeCell(`${cellPrefix}-setup`, ["ow-study-setup", "remove-cell"], setupSource(validated)),
      codeCell(
        `${cellPrefix}-verify-before`,
        ["ow-study-verification", "ow-study-before-timing"],
        beforeVerificationSource(kind)
      ),
      codeCell(`${cellPrefix}-measured`, ["ow-study-measured", `ow-study-${kind}`], measuredSource(kind)),
      codeCell(
        `${cellPrefix}-verify-after`,
        ["ow-study-verification", "ow-study-after-workbench"],
        afterVerificationSource(kind)
      )
    ],
    metadata: {
      kernelspec: {
        display_name: kernel.displayName,
        language: "python",
        name: kernel.name
      },
      language_info: { name: "python", version: "3.12" },
      openWranglerStudy: {
        protocol: DATA_WRANGLER_COMPARISON_NOTEBOOK_PROTOCOL,
        engine,
        format,
        kind,
        kernel: { name: kernel.name, displayName: kernel.displayName },
        fixture: {
          id: fixture.id,
          sha256: fixture.sha256,
          rows: fixture.rows,
          columns: fixture.columns
        },
        sourceReceipt: structuredClone(validated.sourceReceipt),
        sourceEnvironmentVariable: DATA_WRANGLER_COMPARISON_SOURCE_ENVIRONMENT_VARIABLE,
        outputsMustRemainPathFree: true
      }
    },
    nbformat: 4,
    nbformat_minor: 5
  };
}

export function serializeDataWranglerComparisonNotebook(options) {
  return `${JSON.stringify(buildDataWranglerComparisonNotebook(options), null, 2)}\n`;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function writeDataWranglerComparisonNotebook(path, options) {
  const target = resolve(path);
  const temporary = resolve(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = serializeDataWranglerComparisonNotebook(options);
  let descriptor;
  let opened;
  let operationError;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      NOTEBOOK_MODE
    );
    opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error("Comparison notebook target must be a singly linked regular file.");
    }
    fchmodSync(descriptor, NOTEBOOK_MODE);
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
    const completed = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(opened, completed) || (completed.mode & 0o777n) !== 0o600n) {
      throw new Error("Comparison notebook identity or private mode changed while it was written.");
    }
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, target);
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = [];
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    throw new AggregateError(
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors],
      "Could not write the private comparison notebook."
    );
  }
  const completed = lstatSync(target, { bigint: true });
  if (
    opened === undefined ||
    !completed.isFile() ||
    completed.nlink !== 1n ||
    (completed.mode & 0o777n) !== 0o600n ||
    completed.size !== BigInt(Buffer.byteLength(payload)) ||
    !sameIdentity(opened, completed)
  ) {
    throw new Error("The published comparison notebook does not match its private file receipt.");
  }
  return Object.freeze({ path: target, bytes: Buffer.byteLength(payload), mode: "0600" });
}
