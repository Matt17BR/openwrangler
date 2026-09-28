from __future__ import annotations

import base64

import pytest

from openwrangler_runtime.parquet_durations import (
    ARROW_BINARY,
    ARROW_BOOL,
    ARROW_DATE,
    ARROW_UTF8,
    MAX_ARROW_SCHEMA_BYTES,
    arrow_decimal,
    arrow_duration,
    arrow_duration_units,
    arrow_float,
    arrow_integer,
    arrow_list,
    arrow_schema_metadata,
    arrow_struct,
    arrow_time,
    arrow_timestamp,
)

pa = pytest.importorskip("pyarrow")


def decoded(metadata: str | bytes) -> object:
    return pa.ipc.read_schema(pa.py_buffer(base64.b64decode(metadata)))


def test_written_arrow_schema_metadata_decodes_as_the_declared_schema() -> None:
    fields = [
        ("flag", ARROW_BOOL),
        ("small", arrow_integer(8, True)),
        ("count", arrow_integer(64, False)),
        ("ratio", arrow_float(32)),
        ("value", arrow_float(64)),
        ("amount", arrow_decimal(38, 10)),
        ("label", ARROW_UTF8),
        ("payload", ARROW_BINARY),
        ("day", ARROW_DATE),
        ("clock", arrow_time("us")),
        ("coarse clock", arrow_time("ms")),
        ("moment", arrow_timestamp("ns")),
        ("instant", arrow_timestamp("us", "UTC")),
        ("elapsed", arrow_duration("us")),
        ("événements", arrow_list(arrow_struct([("gap", arrow_duration("s")), ("tags", arrow_list(ARROW_UTF8))]))),
    ]
    expected = pa.schema(
        [
            pa.field("flag", pa.bool_()),
            pa.field("small", pa.int8()),
            pa.field("count", pa.uint64()),
            pa.field("ratio", pa.float32()),
            pa.field("value", pa.float64()),
            pa.field("amount", pa.decimal128(38, 10)),
            pa.field("label", pa.string()),
            pa.field("payload", pa.binary()),
            pa.field("day", pa.date32()),
            pa.field("clock", pa.time64("us")),
            pa.field("coarse clock", pa.time32("ms")),
            pa.field("moment", pa.timestamp("ns")),
            pa.field("instant", pa.timestamp("us", "UTC")),
            pa.field("elapsed", pa.duration("us")),
            pa.field(
                "événements",
                pa.list_(pa.struct([pa.field("gap", pa.duration("s")), pa.field("tags", pa.list_(pa.string()))])),
            ),
        ]
    )

    metadata = arrow_schema_metadata(fields)

    assert decoded(metadata) == expected
    assert arrow_duration_units(metadata.encode("ascii"), expected.names) == {"elapsed": "us"}
    assert decoded(arrow_schema_metadata([])) == pa.schema([])


@pytest.mark.parametrize("unit", ["s", "ms", "us", "ns"])
def test_duration_units_come_only_from_top_level_fields_of_the_exact_columns(unit: str) -> None:
    schema = pa.schema(
        [
            pa.field("elapsed", pa.duration(unit)),
            pa.field("nested", pa.list_(pa.duration(unit))),
            pa.field("count", pa.int64()),
        ]
    )
    metadata = base64.b64encode(schema.serialize().to_pybytes())

    assert arrow_duration_units(metadata, schema.names) == {"elapsed": unit}
    assert arrow_duration_units(metadata, ["elapsed", "nested"]) == {}
    assert arrow_duration_units(metadata, ["renamed", "nested", "count"]) == {}


def test_malformed_arrow_schema_metadata_marks_no_durations() -> None:
    message = pa.schema([pa.field("elapsed", pa.duration("us"))]).serialize().to_pybytes()

    for metadata in (
        b"not base64!",
        b"",
        base64.b64encode(message[: len(message) // 2]),
        base64.b64encode(message[:8] + bytes(len(message) - 8)),
        b"A" * (MAX_ARROW_SCHEMA_BYTES + 4),
    ):
        assert arrow_duration_units(metadata, ["elapsed"]) == {}
