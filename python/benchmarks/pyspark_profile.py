from __future__ import annotations

import argparse
import json
import os
import platform
import subprocess
from collections.abc import Iterator
from contextlib import contextmanager
from importlib import import_module
from pathlib import Path
from statistics import median
from time import perf_counter
from typing import Any, Literal

from openwrangler_runtime.engines import PySparkEngine

PROFILE_STUDY_PROTOCOL = "openwrangler-pyspark-profile-study-v1"
WARM_SAMPLE_COUNT = 3
DEFAULT_ROWS = 1_000_000
DEFAULT_PARTITIONS = 32
PROFILE_COLUMN_NAMES = (
    "record_id",
    "score",
    "amount",
    "customer_segment",
    "active",
    "event_at_utc",
    "payload_binary",
    "tags",
    "attributes",
    "details",
)

SparkVariant = Literal["classic", "connect"]


def build_mixed_profile_frame(spark: Any, *, rows: int, partitions: int) -> Any:
    """Build one deterministic Spark-native profiling fixture."""

    if rows < 8:
        raise ValueError("The PySpark profiling fixture requires at least 8 rows.")
    if partitions < 1:
        raise ValueError("The PySpark profiling fixture requires at least one partition.")

    functions = import_module("pyspark.sql.functions")
    source = spark.range(0, rows, 1, partitions)
    index = functions.col("id")
    region = _cyclic_label(functions, ("DACH", "Nordics", "Iberia"), index)
    segment = (
        functions.when(functions.pmod(index, functions.lit(43)) == 0, functions.lit(None).cast("string"))
        .when(functions.pmod(index, functions.lit(10)) < 8, functions.lit("Enterprise"))
        .otherwise(_cyclic_label(functions, ("Mid-market", "Public sector", "Small business"), index))
    )
    score = (
        functions.when(index == 0, functions.lit(-1_000_000.25))
        .when(index == rows - 1, functions.lit(1_000_000.75))
        .when(functions.pmod(index, functions.lit(37)) == 0, functions.lit(None).cast("double"))
        .when(functions.pmod(index, functions.lit(41)) == 0, functions.lit(float("nan")))
        .otherwise(
            functions.pmod(index * functions.lit(17), functions.lit(10_000)).cast("double") / functions.lit(10.0)
            - functions.lit(500.0)
        )
    )
    amount = functions.when(
        functions.pmod(index, functions.lit(31)) == 0,
        functions.lit(None).cast("decimal(18,2)"),
    ).otherwise(
        (functions.pmod(index * functions.lit(7_919), functions.lit(2_000_001)) - functions.lit(1_000_000)).cast(
            "decimal(18,2)"
        )
    )
    active = functions.when(
        functions.pmod(index, functions.lit(47)) == 0,
        functions.lit(None).cast("boolean"),
    ).otherwise(functions.pmod(index, functions.lit(3)) != 0)
    event_at = functions.when(
        functions.pmod(index, functions.lit(53)) == 0,
        functions.lit(None).cast("timestamp"),
    ).otherwise(functions.timestamp_seconds(functions.lit(1_704_067_200) + index * functions.lit(60)))
    payload_binary = functions.when(
        functions.pmod(index, functions.lit(59)) == 0,
        functions.lit(None).cast("binary"),
    ).otherwise(functions.encode(functions.concat(functions.lit("payload-"), index.cast("string")), "UTF-8"))
    tags = functions.when(
        functions.pmod(index, functions.lit(61)) == 0,
        functions.lit(None).cast("array<string>"),
    ).otherwise(
        functions.array(
            segment,
            functions.concat(functions.lit("tier-"), functions.pmod(index, functions.lit(4)).cast("string")),
        )
    )
    attributes = functions.when(
        functions.pmod(index, functions.lit(67)) == 0,
        functions.lit(None).cast("map<string,string>"),
    ).otherwise(
        functions.create_map(
            functions.lit("region"),
            region,
            functions.lit("bucket"),
            functions.pmod(index, functions.lit(5)).cast("string"),
        )
    )
    details = functions.when(
        functions.pmod(index, functions.lit(71)) == 0,
        functions.lit(None).cast("struct<region:string,priority:int>"),
    ).otherwise(
        functions.struct(
            region.alias("region"),
            functions.pmod(index, functions.lit(5)).cast("int").alias("priority"),
        )
    )

    frame = source.select(
        index.alias("record_id"),
        score.alias("score"),
        amount.alias("amount"),
        segment.alias("customer_segment"),
        active.alias("active"),
        event_at.alias("event_at_utc"),
        payload_binary.alias("payload_binary"),
        tags.alias("tags"),
        attributes.alias("attributes"),
        details.alias("details"),
    )
    if tuple(frame.columns) != PROFILE_COLUMN_NAMES:
        raise AssertionError(f"Unexpected PySpark profiling fixture columns: {frame.columns!r}.")
    return frame


def _cyclic_label(functions: Any, values: tuple[str, ...], index: Any) -> Any:
    return functions.element_at(
        functions.array(*[functions.lit(value) for value in values]),
        (functions.pmod(index, functions.lit(len(values))) + functions.lit(1)).cast("int"),
    )


def summary_projection(schema: list[dict[str, Any]]) -> list[tuple[int, str]]:
    return [(int(column["position"]), f"profile:{column['name']}") for column in schema]


def _measure_warm_samples(engine: PySparkEngine, frame: Any, projection: list[tuple[int, str]]) -> dict[str, Any]:
    warmup = engine.summaries(frame, projection)
    _assert_summary_order(warmup, projection)
    samples: list[float] = []
    for _sample in range(WARM_SAMPLE_COUNT):
        started = perf_counter()
        summaries = engine.summaries(frame, projection)
        samples.append((perf_counter() - started) * 1_000)
        _assert_summary_order(summaries, projection)
    rounded = [round(sample, 3) for sample in samples]
    return {
        "samplesMs": rounded,
        "medianMs": round(float(median(samples)), 3),
        "maxMs": round(max(samples), 3),
    }


def _assert_summary_order(summaries: list[dict[str, Any]], projection: list[tuple[int, str]]) -> None:
    expected_ids = [column_id for _position, column_id in projection]
    actual_ids = [summary.get("columnId") for summary in summaries]
    if actual_ids != expected_ids:
        raise AssertionError(f"PySpark summaries changed projection order: {actual_ids!r} != {expected_ids!r}.")


@contextmanager
def _conversion_guards(frame: Any) -> Iterator[list[str]]:
    dataframe_type = type(frame)
    replacements: list[tuple[str, bool, Any]] = []

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("The PySpark profile study must not convert a dataframe through Pandas or Arrow.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if not hasattr(dataframe_type, method_name):
            continue
        owned = method_name in dataframe_type.__dict__
        replacements.append((method_name, owned, dataframe_type.__dict__.get(method_name)))
        setattr(dataframe_type, method_name, forbidden)
    try:
        yield [method_name for method_name, _owned, _original in replacements]
    finally:
        for method_name, owned, original in reversed(replacements):
            if owned:
                setattr(dataframe_type, method_name, original)
            else:
                delattr(dataframe_type, method_name)


def _profile_variant(variant: SparkVariant, *, rows: int, partitions: int) -> dict[str, Any]:
    SparkSession = import_module("pyspark.sql").SparkSession
    builder = (
        SparkSession.builder.master("local[4]") if variant == "classic" else SparkSession.builder.remote("local[4]")
    )
    builder = (
        builder.appName(f"open-wrangler-{variant}-profile-study")
        .config("spark.sql.shuffle.partitions", str(partitions))
        .config("spark.sql.session.timeZone", "UTC")
    )
    if variant == "classic":
        builder = builder.config("spark.ui.enabled", "false")
    spark = builder.getOrCreate()
    if variant == "classic":
        spark.sparkContext.setLogLevel("ERROR")

    engine = PySparkEngine()
    engine_closed = False
    session_usable_after_cleanup = False
    try:
        source = build_mixed_profile_frame(spark, rows=rows, partitions=partitions)
        engine.validate_internal_row_id_namespace(source)
        engine.validate_column_addressability(source)
        indexed = engine.ensure_row_ids(source, f"profile-{variant}")
        observed_rows = int(indexed.count())
        if observed_rows != rows:
            raise AssertionError(f"PySpark fixture has {observed_rows:,} rows; expected {rows:,}.")
        schema = engine.schema(indexed)
        if [column["name"] for column in schema] != list(PROFILE_COLUMN_NAMES):
            raise AssertionError(f"Unexpected PySpark profiling schema: {schema!r}.")
        projection = summary_projection(schema)
        score_projection = [projection[1]]
        with _conversion_guards(indexed) as conversion_guards:
            selected = _measure_warm_samples(engine, indexed, score_projection)
            all_columns = _measure_warm_samples(engine, indexed, projection)
        result = {
            "sparkVersion": str(spark.version),
            "sessionTimeZone": str(spark.conf.get("spark.sql.session.timeZone")),
            "conversionGuards": conversion_guards,
            "selectedColumn": PROFILE_COLUMN_NAMES[1],
            "selectedColumnProfile": selected,
            "allColumnProfiles": all_columns,
        }
    finally:
        engine.close()
        engine_closed = True
        try:
            session_usable_after_cleanup = int(spark.range(1).count()) == 1
        finally:
            spark.stop()
    result["cleanup"] = {
        "engineClosed": engine_closed,
        "userSparkSessionUsableBeforeStop": session_usable_after_cleanup,
    }
    return result


def _machine_details() -> dict[str, Any]:
    return {
        "operatingSystem": platform.system(),
        "operatingSystemRelease": platform.release(),
        "architecture": platform.machine(),
        "cpuModel": _cpu_model(),
        "logicalCpuCount": os.cpu_count(),
        "totalMemoryBytes": _total_memory_bytes(),
        "pythonVersion": platform.python_version(),
        "javaVersion": _java_version(),
    }


def _cpu_model() -> str | None:
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() in {"model name", "Hardware"}:
                return value.strip()
    except OSError:
        pass
    return platform.processor() or None


def _total_memory_bytes() -> int | None:
    try:
        return int(os.sysconf("SC_PAGE_SIZE")) * int(os.sysconf("SC_PHYS_PAGES"))
    except (AttributeError, OSError, TypeError, ValueError):
        return None


def _java_version() -> str | None:
    try:
        result = subprocess.run(
            ["java", "-version"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None
    output = (result.stderr or result.stdout).splitlines()
    return output[0].strip() if output else None


def _source_revision() -> str | None:
    try:
        return subprocess.run(
            ["git", "-C", str(Path(__file__).resolve().parents[2]), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
    except (FileNotFoundError, OSError, subprocess.SubprocessError):
        return None


def run_profile_study(*, rows: int, partitions: int) -> dict[str, Any]:
    return {
        "protocol": PROFILE_STUDY_PROTOCOL,
        "sourceRevision": _source_revision(),
        "warmSamplesPerMode": WARM_SAMPLE_COUNT,
        "fixture": {
            "rows": rows,
            "columns": len(PROFILE_COLUMN_NAMES),
            "partitions": partitions,
            "columnNames": list(PROFILE_COLUMN_NAMES),
            "construction": "deterministic Spark SQL expressions over spark.range",
        },
        "machine": _machine_details(),
        "variants": {
            variant: _profile_variant(variant, rows=rows, partitions=partitions) for variant in ("classic", "connect")
        },
        "thresholds": None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Measure warm selected-column and all-column profiles in local PySpark Classic and Connect."
    )
    parser.add_argument("--rows", type=int, default=DEFAULT_ROWS)
    parser.add_argument("--partitions", type=int, default=DEFAULT_PARTITIONS)
    parser.add_argument("--json-out", type=Path)
    arguments = parser.parse_args()
    report = run_profile_study(rows=arguments.rows, partitions=arguments.partitions)
    rendered = json.dumps(report, indent=2, sort_keys=True)
    if arguments.json_out is not None:
        arguments.json_out.parent.mkdir(parents=True, exist_ok=True)
        arguments.json_out.write_text(f"{rendered}\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
