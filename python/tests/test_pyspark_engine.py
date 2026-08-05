from __future__ import annotations

import json
import re
import signal
import threading
from collections.abc import Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from decimal import Decimal
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import __main__
import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
import openwrangler_runtime.server as server
from openwrangler_runtime.engines import EngineError, PySparkEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.session import LiveSourceInvalidatedError, SessionManager

_PYSPARK_VERSION_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "pyspark-version-contract.json").read_text(encoding="utf-8")
)


def test_strict_pyspark_version_contract() -> None:
    assert all(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for version in _PYSPARK_VERSION_CONTRACT["accepted"]
    )
    assert not any(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for version in _PYSPARK_VERSION_CONTRACT["rejected"]
    )


@pytest.fixture(scope="module", params=("classic", "connect"))
def spark_session(request: pytest.FixtureRequest) -> Iterator[Any]:
    pyspark = pytest.importorskip("pyspark")
    assert pyspark.__version__.startswith("4.2.")
    SparkSession = import_module("pyspark.sql").SparkSession

    if request.param == "classic":
        spark = (
            SparkSession.builder.master("local[2]")
            .appName("open-wrangler-pyspark-tests")
            .config("spark.ui.enabled", "false")
            .config("spark.sql.shuffle.partitions", "2")
            .getOrCreate()
        )
        spark.sparkContext.setLogLevel("ERROR")
    else:
        spark = SparkSession.builder.remote("local[2]").getOrCreate()
        spark.conf.set("spark.sql.shuffle.partitions", "2")
    try:
        yield spark
    finally:
        spark.stop()


@pytest.fixture
def sample_frame(spark_session: Any) -> Any:
    return spark_session.createDataFrame(
        [
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
            ("alpha", None, "y", False, datetime(2026, 1, 2, 12, 0)),
            ("ALPHA", float("nan"), "y", None, None),
            ("ÄLPHA", -1.0, "x", True, datetime(2026, 1, 3, 12, 0)),
            ("Beta", 2.0, "x", True, datetime(2026, 1, 1, 12, 0)),
        ],
        "name string, amount double, group_name string, flag boolean, happened timestamp",
    ).repartition(2)


def _open_engine(frame: Any, token: str = "test") -> tuple[PySparkEngine, Any]:
    engine = PySparkEngine()
    assert engine.detect(frame)
    engine.validate_internal_row_id_namespace(frame)
    engine.validate_column_addressability(frame)
    return engine, engine.ensure_row_ids(frame, token)


def _current_task_job_group(_value: int) -> str | None:
    task_context = import_module("pyspark").TaskContext.get()
    assert task_context is not None
    return task_context.getLocalProperty("spark.jobGroup.id")


def _empty_view() -> dict[str, Any]:
    return {"logic": "and", "filters": [], "sort": []}


class _FakeSparkContext:
    def __init__(
        self,
        properties: dict[str, str] | None = None,
        *,
        fail_job_group_after_update: bool = False,
    ) -> None:
        self.properties = dict(properties or {})
        self.groups: list[str] = []
        self.fail_job_group_after_update = fail_job_group_after_update

    def getLocalProperty(self, key: str) -> str | None:
        return self.properties.get(key)

    def setLocalProperty(self, key: str, value: str | None) -> None:
        if value is None:
            self.properties.pop(key, None)
        else:
            self.properties[key] = value

    def setJobGroup(
        self,
        group_id: str,
        description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        self.groups.append(group_id)
        self.setLocalProperty("spark.job.description", description)
        self.setLocalProperty("spark.jobGroup.id", group_id)
        self.setLocalProperty("spark.job.interruptOnCancel", str(interruptOnCancel).lower())
        if self.fail_job_group_after_update:
            raise RuntimeError("job-group setup failed")


class _ThreadLocalFakeSparkContext:
    def __init__(self) -> None:
        self._local = threading.local()
        self._groups_lock = threading.Lock()
        self.groups: list[tuple[int, str]] = []

    @property
    def properties(self) -> dict[str, str]:
        properties = getattr(self._local, "properties", None)
        if properties is None:
            properties = {}
            self._local.properties = properties
        return properties

    def getLocalProperty(self, key: str) -> str | None:
        return self.properties.get(key)

    def setLocalProperty(self, key: str, value: str | None) -> None:
        if value is None:
            self.properties.pop(key, None)
        else:
            self.properties[key] = value

    def setJobGroup(
        self,
        group_id: str,
        description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        self.setLocalProperty("spark.job.description", description)
        self.setLocalProperty("spark.jobGroup.id", group_id)
        self.setLocalProperty("spark.job.interruptOnCancel", str(interruptOnCancel).lower())
        with self._groups_lock:
            self.groups.append((threading.get_ident(), group_id))


class _StoppedSparkContext:
    def __init__(self) -> None:
        self.ownership_calls = 0

    def getLocalProperty(self, _key: str) -> str | None:
        self.ownership_calls += 1
        raise RuntimeError("Spark context is stopped")


class _RestoreFailingSparkContext:
    def __init__(self) -> None:
        self.ownership_calls = 0
        self._request_group_set = False

    def getLocalProperty(self, _key: str) -> str | None:
        self.ownership_calls += 1
        return None

    def setJobGroup(
        self,
        _group_id: str,
        _description: str,
        interruptOnCancel: bool = False,
    ) -> None:
        del interruptOnCancel
        self.ownership_calls += 1
        self._request_group_set = True

    def setLocalProperty(self, _key: str, _value: str | None) -> None:
        self.ownership_calls += 1
        if self._request_group_set:
            raise RuntimeError("Spark properties cannot be restored")


class _FakeClassicFrame:
    def __init__(self, spark_context: Any) -> None:
        self.sparkSession = SimpleNamespace(sparkContext=spark_context)


class _FakeConnectFrame:
    def __init__(self) -> None:
        self.sparkSession = SimpleNamespace()


_FakeConnectFrame.__module__ = "pyspark.sql.connect.dataframe"


class _ClosablePySparkSession:
    def __init__(self, session_id: str, engine: PySparkEngine) -> None:
        self.session_id = session_id
        self.engine = engine
        self.disposed = False
        self.lock = threading.RLock()
        self.admission_condition = threading.Condition(threading.Lock())
        self.profile_condition = threading.Condition(self.lock)
        self.active_profiles = 0
        self.waiting_writers = 0

    def dispose(self) -> None:
        self.disposed = True
        self.engine.close()


def test_capabilities_are_explicitly_read_only_and_not_file_backed() -> None:
    capabilities = PySparkEngine.capabilities
    assert capabilities.source_kinds == frozenset({"notebookVariable"})
    assert not capabilities.supports_editing
    assert capabilities.lazy_file_extensions == frozenset()
    assert capabilities.export_formats == frozenset()
    assert not capabilities.supports_shutdown_interrupt
    assert not capabilities.supports_request_cancellation

    engine = PySparkEngine()
    with pytest.raises(EngineError, match="live notebook variables only"):
        engine.read_file("sample.parquet")
    with pytest.raises(EngineError, match="read-only"):
        engine.apply_transform(object(), {})
    with pytest.raises(EngineError, match="does not generate"):
        engine.compile_plan(())
    with pytest.raises(EngineError, match="does not export"):
        engine.export_data(object(), "cleaned.parquet", "parquet")


def test_classic_request_scope_owns_jobs_and_restores_the_callers_properties() -> None:
    caller_properties = {
        "spark.job.description": "User analysis",
        "spark.jobGroup.id": "user-job",
        "spark.job.interruptOnCancel": "true",
        "spark.job.tags": "user-tag",
        "spark.scheduler.pool": "user-pool",
        "user.property": "unchanged",
    }
    spark_context = _FakeSparkContext(caller_properties)
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)
    previous_sigint = signal.getsignal(signal.SIGINT)

    with engine.request_scope("2e6420ea-f6c6-4109-b9f0-907c301af176"):
        assert pyspark_engine_module._current_pyspark_request_id() == "2e6420ea-f6c6-4109-b9f0-907c301af176"
        assert spark_context.properties == {
            **caller_properties,
            "spark.job.description": "Open Wrangler request",
            "spark.jobGroup.id": "open-wrangler:2e6420ea-f6c6-4109-b9f0-907c301af176",
            "spark.job.interruptOnCancel": "false",
        }
        assert signal.getsignal(signal.SIGINT) is previous_sigint

    assert spark_context.properties == caller_properties
    assert spark_context.groups == ["open-wrangler:2e6420ea-f6c6-4109-b9f0-907c301af176"]
    assert pyspark_engine_module._current_pyspark_request_id() is None
    assert signal.getsignal(signal.SIGINT) is previous_sigint


def test_classic_request_scope_restores_nested_and_failed_requests() -> None:
    spark_context = _FakeSparkContext()
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)

    with engine.request_scope("outer-request"):
        outer_properties = dict(spark_context.properties)
        with engine.request_scope("inner-request"):
            assert spark_context.getLocalProperty("spark.jobGroup.id") == "open-wrangler:inner-request"
            assert pyspark_engine_module._current_pyspark_request_id() == "inner-request"
        assert spark_context.properties == outer_properties
        assert pyspark_engine_module._current_pyspark_request_id() == "outer-request"
        with pytest.raises(RuntimeError, match="profile failed"), engine.request_scope("failed-request"):
            raise RuntimeError("profile failed")
        assert spark_context.properties == outer_properties
        assert pyspark_engine_module._current_pyspark_request_id() == "outer-request"

    assert spark_context.properties == {}
    assert pyspark_engine_module._current_pyspark_request_id() is None
    assert spark_context.groups == [
        "open-wrangler:outer-request",
        "open-wrangler:inner-request",
        "open-wrangler:failed-request",
    ]


def test_classic_request_scope_isolates_overlapping_threads() -> None:
    spark_context = _ThreadLocalFakeSparkContext()
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)
    both_scopes_active = threading.Barrier(2)
    both_scopes_observed = threading.Barrier(2)

    def run_request(request_id: str) -> tuple[int, dict[str, str], dict[str, str], str | None]:
        thread_id = threading.get_ident()
        caller_properties = {
            "spark.job.description": f"caller-{request_id}",
            "spark.jobGroup.id": f"caller-group-{request_id}",
            "spark.job.interruptOnCancel": "true",
            "spark.scheduler.pool": f"pool-{request_id}",
        }
        spark_context.properties.update(caller_properties)
        with engine.request_scope(request_id):
            both_scopes_active.wait(timeout=5)
            inside = dict(spark_context.properties)
            both_scopes_observed.wait(timeout=5)
        return (
            thread_id,
            inside,
            dict(spark_context.properties),
            pyspark_engine_module._current_pyspark_request_id(),
        )

    request_ids = ("first-request", "second-request")
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(run_request, request_id) for request_id in request_ids]
        results = [future.result(timeout=10) for future in futures]

    assert len({thread_id for thread_id, _inside, _after, _active_request in results}) == 2
    for request_id, (_thread_id, inside, after, active_request) in zip(request_ids, results, strict=True):
        assert inside == {
            "spark.job.description": "Open Wrangler request",
            "spark.jobGroup.id": f"open-wrangler:{request_id}",
            "spark.job.interruptOnCancel": "false",
            "spark.scheduler.pool": f"pool-{request_id}",
        }
        assert after == {
            "spark.job.description": f"caller-{request_id}",
            "spark.jobGroup.id": f"caller-group-{request_id}",
            "spark.job.interruptOnCancel": "true",
            "spark.scheduler.pool": f"pool-{request_id}",
        }
        assert active_request is None
    assert {group for _thread_id, group in spark_context.groups} == {
        "open-wrangler:first-request",
        "open-wrangler:second-request",
    }
    assert pyspark_engine_module._current_pyspark_request_id() is None


def test_classic_request_scope_restores_the_caller_after_partial_setup_failure() -> None:
    caller_properties = {
        "spark.job.description": "Caller job",
        "spark.jobGroup.id": "caller-group",
        "spark.job.interruptOnCancel": "true",
    }
    spark_context = _FakeSparkContext(caller_properties, fail_job_group_after_update=True)
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)

    with (
        pytest.raises(EngineError, match="Could not establish PySpark request ownership"),
        engine.request_scope("failed-setup"),
    ):
        raise AssertionError("the request body must not run")

    assert spark_context.properties == caller_properties
    assert pyspark_engine_module._current_pyspark_request_id() is None


def test_classic_request_scope_does_not_mask_an_earlier_failure_during_restore(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    spark_context = _FakeSparkContext()
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)

    def fail_restore(_spark_context: Any, _properties: Mapping[str, str | None]) -> None:
        raise EngineError("restore failed")

    monkeypatch.setattr(pyspark_engine_module, "_restore_spark_job_properties", fail_restore)

    with pytest.raises(RuntimeError, match="profile failed"), engine.request_scope("failed-request"):
        raise RuntimeError("profile failed")

    assert pyspark_engine_module._current_pyspark_request_id() is None


def test_connect_request_scope_keeps_only_local_request_identity() -> None:
    engine = PySparkEngine()
    frame = _FakeConnectFrame()
    engine._indexed_frame = frame
    previous_sigint = signal.getsignal(signal.SIGINT)

    with engine.request_scope("connect-request"):
        assert pyspark_engine_module._current_pyspark_request_id() == "connect-request"
        assert vars(frame.sparkSession) == {}
        assert signal.getsignal(signal.SIGINT) is previous_sigint

    assert pyspark_engine_module._current_pyspark_request_id() is None
    assert vars(frame.sparkSession) == {}
    assert signal.getsignal(signal.SIGINT) is previous_sigint


def test_real_local_request_scope_isolated_by_classic_job_group_or_connect_operation(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    engine, indexed = _open_engine(sample_frame, "request-ownership")
    previous_sigint = signal.getsignal(signal.SIGINT)

    if type(indexed).__module__.startswith("pyspark.sql.connect."):
        tags_before = set(spark_session.getTags())
        with engine.request_scope("e694e5ad-947b-4dba-8197-806434d91cd0"):
            assert pyspark_engine_module._current_pyspark_request_id() == ("e694e5ad-947b-4dba-8197-806434d91cd0")
            assert indexed.limit(1).collect()
            assert set(spark_session.getTags()) == tags_before
        assert set(spark_session.getTags()) == tags_before
    else:
        spark_context = spark_session.sparkContext
        keys = (
            "spark.job.description",
            "spark.jobGroup.id",
            "spark.job.interruptOnCancel",
            "spark.job.tags",
            "spark.scheduler.pool",
        )
        original = {key: spark_context.getLocalProperty(key) for key in keys}
        caller = {
            "spark.job.description": "User analysis",
            "spark.jobGroup.id": "user-job",
            "spark.job.interruptOnCancel": "true",
            "spark.job.tags": "user-tag",
            "spark.scheduler.pool": "user-pool",
        }
        try:
            for key, value in caller.items():
                spark_context.setLocalProperty(key, value)
            observed_groups: list[str | None] = []
            for request_id in (
                "bfe034be-1ad6-4893-945b-c50c75ed6c4f",
                "5ccb22a4-5f31-4ee0-95eb-4bf165a13ee9",
            ):
                with engine.request_scope(request_id):
                    observed_groups.extend(spark_context.parallelize([0], 1).map(_current_task_job_group).collect())
                    assert spark_context.getLocalProperty("spark.job.tags") == "user-tag"
                    assert spark_context.getLocalProperty("spark.scheduler.pool") == "user-pool"
                assert {key: spark_context.getLocalProperty(key) for key in keys} == caller
            assert observed_groups == [
                "open-wrangler:bfe034be-1ad6-4893-945b-c50c75ed6c4f",
                "open-wrangler:5ccb22a4-5f31-4ee0-95eb-4bf165a13ee9",
            ]
        finally:
            for key, value in original.items():
                spark_context.setLocalProperty(key, value)

    assert pyspark_engine_module._current_pyspark_request_id() is None
    assert signal.getsignal(signal.SIGINT) is previous_sigint


def test_connect_stopped_probe_uses_the_session_local_flag() -> None:
    class ConnectSession:
        def __init__(self, stopped: bool) -> None:
            self.is_stopped = stopped

    class Frame:
        def __init__(self, stopped: bool) -> None:
            self.sparkSession = ConnectSession(stopped)

    assert PySparkEngine.live_source_is_stopped(Frame(False)) is False
    assert PySparkEngine.live_source_is_stopped(Frame(True)) is True


def test_classic_stopped_probe_uses_the_cleared_context_handle_and_jvm_state() -> None:
    class JavaContext:
        def __init__(self, stopped: bool) -> None:
            self.stopped = stopped

        def sc(self) -> JavaContext:
            return self

        def isStopped(self) -> bool:
            return self.stopped

    class SparkContext:
        def __init__(self, java_context: Any) -> None:
            self._jsc = java_context

    class ClassicSession:
        def __init__(self, java_context: Any) -> None:
            self.sparkContext = SparkContext(java_context)

    class Frame:
        def __init__(self, java_context: Any) -> None:
            self.sparkSession = ClassicSession(java_context)

    assert PySparkEngine.live_source_is_stopped(Frame(JavaContext(False))) is False
    assert PySparkEngine.live_source_is_stopped(Frame(JavaContext(True))) is True
    assert PySparkEngine.live_source_is_stopped(Frame(None)) is True


def test_stopped_probe_does_not_misclassify_unknown_or_failed_liveness_checks() -> None:
    class UnknownContext:
        pass

    class BrokenJavaContext:
        def sc(self) -> Any:
            raise RuntimeError("gateway unavailable")

    class Session:
        def __init__(self, context: Any) -> None:
            self.sparkContext = context

    class Frame:
        def __init__(self, context: Any) -> None:
            self.sparkSession = Session(context)

    assert PySparkEngine.live_source_is_stopped(Frame(UnknownContext())) is False
    assert PySparkEngine.live_source_is_stopped(Frame(type("Context", (), {"_jsc": BrokenJavaContext()})())) is False


def test_detects_classic_and_connect_dataframes(spark_session: Any) -> None:
    frame = spark_session.range(3)
    assert PySparkEngine().detect(frame)
    assert not PySparkEngine().detect(object())
    assert type(frame).__module__ in {
        "pyspark.sql.classic.dataframe",
        "pyspark.sql.connect.dataframe",
    }


@pytest.mark.parametrize(
    "raw_type",
    [
        "variant",
        "time(6)",
        "geometry(4326)",
        "geography(any)",
        "interval",
        "interval year",
        "interval month",
        "interval year to month",
    ],
)
def test_classifies_exact_non_profileable_spark_types(raw_type: str) -> None:
    assert pyspark_engine_module._is_unsupported_profile_type(raw_type)


@pytest.mark.parametrize("raw_type", ["void", "custom_type", "interval day to second"])
def test_does_not_blanket_reject_unknown_or_supported_interval_types(raw_type: str) -> None:
    assert not pyspark_engine_module._is_unsupported_profile_type(raw_type)


def test_rejects_streaming_duplicate_casefold_and_private_schemas(spark_session: Any) -> None:
    engine = PySparkEngine()
    duplicate = spark_session.createDataFrame([(1, 2)], ["value", "value"])
    with pytest.raises(EngineError, match="unique without relying on case"):
        engine.validate_column_addressability(duplicate)

    casefold = spark_session.createDataFrame([(1, 2)], ["Value", "value"])
    with pytest.raises(EngineError, match="unique without relying on case"):
        engine.validate_column_addressability(casefold)

    private = spark_session.createDataFrame([(1,)], [f"{INTERNAL_ROW_ID_PREFIX.upper()}user"])
    with pytest.raises(EngineError, match="reserved"):
        engine.validate_internal_row_id_namespace(private)

    streaming = spark_session.readStream.format("rate").load()
    with pytest.raises(EngineError, match="Streaming"):
        engine.validate_column_addressability(streaming)


def test_rejects_variant_before_open_without_blanket_rejecting_unknown_types(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variant = spark_session.sql("""SELECT parse_json('{"region":"eu"}') AS payload""")
    monkeypatch.setattr(__main__, "open_wrangler_variant_frame", variant, raising=False)
    manager = SessionManager()

    with pytest.raises(
        EngineError,
        match=r"required viewing profiles.*'payload' \(variant\).*Convert these columns in Spark",
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_variant_frame",
                "label": "open_wrangler_variant_frame",
            },
            backend="pyspark",
        )
    assert manager.sessions == {}

    # Spark's void type is also semantically unknown to the shared type
    # classifier, but it supports the required native grouping operations.
    # Exact unsupported Spark types must fail closed without rejecting every
    # column that happens to map to the public "unknown" semantic type.
    supported_unknown = spark_session.sql("SELECT CAST(NULL AS VOID) AS payload")
    engine = PySparkEngine()
    engine.validate_column_addressability(supported_unknown)
    assert engine.schema(supported_unknown) == [
        {
            "id": "c:0",
            "name": "payload",
            "position": 0,
            "rawType": "void",
            "type": "unknown",
            "nullable": True,
        }
    ]


@pytest.mark.parametrize(
    ("expression", "raw_type"),
    [
        (
            """named_struct('x', parse_json('{"region":"eu"}'))""",
            "struct<x:variant>",
        ),
        (
            """array(parse_json('{"region":"eu"}'))""",
            "array<variant>",
        ),
        (
            """map('x', parse_json('{"region":"eu"}'))""",
            "map<string,variant>",
        ),
        (
            """named_struct('x', INTERVAL '1-2' YEAR TO MONTH)""",
            "struct<x:interval year to month>",
        ),
        (
            """array(INTERVAL '1-2' YEAR TO MONTH)""",
            "array<interval year to month>",
        ),
    ],
)
def test_rejects_nested_non_profileable_types_before_indexing(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    expression: str,
    raw_type: str,
) -> None:
    frame = spark_session.sql(f"SELECT {expression} AS payload")
    assert frame.schema.fields[0].dataType.simpleString() == raw_type
    monkeypatch.setattr(__main__, "open_wrangler_nested_unsupported", frame, raising=False)
    indexing_calls = 0

    def fail_if_indexed(self: PySparkEngine, value: Any, token: str) -> Any:
        del self, value, token
        nonlocal indexing_calls
        indexing_calls += 1
        raise AssertionError("Unsupported nested types must fail before Spark row-identity projection.")

    monkeypatch.setattr(PySparkEngine, "ensure_row_ids", fail_if_indexed)
    manager = SessionManager()
    with pytest.raises(
        EngineError,
        match=rf"required viewing profiles.*'payload' \({re.escape(raw_type)}\).*Convert these columns in Spark",
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_nested_unsupported",
                "label": "open_wrangler_nested_unsupported",
            },
            backend="pyspark",
        )
    assert indexing_calls == 0
    assert manager.sessions == {}


@pytest.mark.parametrize(
    ("first_name", "second_name"),
    [
        ("x", "x"),
        ("Value", "value"),
    ],
)
def test_rejects_ambiguous_nested_struct_fields_before_indexing(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    first_name: str,
    second_name: str,
) -> None:
    frame = spark_session.sql(f"SELECT named_struct('{first_name}', 1, '{second_name}', 2) AS payload")
    monkeypatch.setattr(__main__, "open_wrangler_ambiguous_nested", frame, raising=False)
    indexing_calls = 0

    def fail_if_indexed(self: PySparkEngine, value: Any, token: str) -> Any:
        del self, value, token
        nonlocal indexing_calls
        indexing_calls += 1
        raise AssertionError("Ambiguous nested fields must fail before Spark row-identity projection.")

    monkeypatch.setattr(PySparkEngine, "ensure_row_ids", fail_if_indexed)
    manager = SessionManager()
    with pytest.raises(
        EngineError,
        match=(
            rf"nested struct fields.*{re.escape(first_name)}.*"
            rf"{re.escape(second_name)}.*Rename the conflicting nested fields"
        ),
    ):
        manager.open_session(
            {
                "kind": "notebookVariable",
                "variableName": "open_wrangler_ambiguous_nested",
                "label": "open_wrangler_ambiguous_nested",
            },
            backend="pyspark",
        )
    assert indexing_calls == 0
    assert manager.sessions == {}


def test_index_is_lazy_and_close_releases_without_an_action(monkeypatch: pytest.MonkeyPatch) -> None:
    class IndexedFrame:
        columns = [f"{INTERNAL_ROW_ID_PREFIX}unit"]
        isStreaming = False

        def __init__(self) -> None:
            self.action_calls = 0

    class SourceFrame:
        columns = ["value"]
        isStreaming = False

        def __init__(self, indexed: IndexedFrame) -> None:
            self.indexed = indexed
            self.with_column_calls = 0

        def withColumn(self, name: str, _expression: object) -> IndexedFrame:
            self.with_column_calls += 1
            self.indexed.columns = ["value", name]
            return self.indexed

    indexed = IndexedFrame()
    source = SourceFrame(indexed)
    monkeypatch.setattr(
        PySparkEngine,
        "_require_supported_frame",
        staticmethod(lambda _frame: None),
    )
    real_import_module = pyspark_engine_module.import_module
    monkeypatch.setattr(
        pyspark_engine_module,
        "import_module",
        lambda name: (
            SimpleNamespace(monotonically_increasing_id=lambda: object())
            if name == "pyspark.sql.functions"
            else real_import_module(name)
        ),
    )
    engine = PySparkEngine()

    result = engine.ensure_row_ids(source, "unit")
    assert result is indexed
    assert source.with_column_calls == 1
    assert engine.shape(indexed) == {"rows": None, "columns": 1}

    engine.close()
    engine.close()
    assert indexed.action_calls == 0


def test_first_page_does_not_cache_the_complete_relation_or_stop_spark(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    storage_level = import_module("pyspark").StorageLevel
    engine, indexed = _open_engine(sample_frame, "bounded-open")
    assert indexed.storageLevel == storage_level.NONE

    page = engine.page(indexed, 0, 2, total_rows=None, column_projection=[(0, "name-id")])
    assert len(page["rows"]) == 2
    assert page["totalRows"] is None
    assert page["hasMore"] is True
    assert indexed.storageLevel == storage_level.NONE

    engine.close()
    assert indexed.storageLevel == storage_level.NONE
    assert spark_session.range(1).count() == 1


def test_classic_first_page_schedules_only_bounded_partition_work(spark_session: Any) -> None:
    if ".connect." in type(spark_session).__module__:
        pytest.skip("Spark Connect uses the same local server plan, but does not expose its status tracker.")
    partition_count = 32
    source = spark_session.range(1_000_000, numPartitions=partition_count).selectExpr("id", "id * 2 AS value")
    engine, indexed = _open_engine(source, "bounded-stage")
    tracker = spark_session.sparkContext.statusTracker()
    jobs_before = set(tracker.getJobIdsForGroup(None))
    try:
        page = engine.page(indexed, 0, 50, total_rows=None, column_projection=[(0, "id")])
        assert len(page["rows"]) == 50
        jobs_after = set(tracker.getJobIdsForGroup(None))
        stage_task_counts: list[int] = []
        for job_id in jobs_after - jobs_before:
            job = tracker.getJobInfo(job_id)
            if job is None:
                continue
            for stage_id in job.stageIds:
                stage = tracker.getStageInfo(stage_id)
                if stage is not None:
                    stage_task_counts.append(stage.numTasks)
        assert stage_task_counts
        assert max(stage_task_counts) < partition_count
        assert len(spark_session.sparkContext._jsc.sc().getRDDStorageInfo()) == 0
    finally:
        engine.close()


def test_progressive_page_rejects_a_changed_partition_traversal(
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    functions = import_module("pyspark.sql.functions")
    engine, indexed = _open_engine(sample_frame, "changed-traversal")
    dataframe_type = type(indexed)
    original_offset = dataframe_type.offset
    row_id = engine.internal_row_id_column(indexed)
    assert isinstance(row_id, str)
    try:
        first = engine.page(indexed, 0, 2, total_rows=None, column_projection=[(0, "name-id")])
        assert first["hasMore"] is True

        def reordered_offset(frame: Any, value: int) -> Any:
            reordered = frame.orderBy(functions.col(f"`{row_id.replace('`', '``')}`").desc())
            return original_offset(reordered, value)

        with monkeypatch.context() as page_patch:
            page_patch.setattr(dataframe_type, "offset", reordered_offset)
            with pytest.raises(EngineError, match="traversal changed"):
                engine.page(indexed, 2, 2, total_rows=None, column_projection=[(0, "name-id")])
    finally:
        engine.close()


def test_explicit_sort_page_preserves_sort_order_and_stable_row_identity(
    spark_session: Any,
    sample_frame: Any,
) -> None:
    engine, indexed = _open_engine(sample_frame, "identity")
    try:
        ascending = engine.apply_filter_model(
            indexed,
            {
                "logic": "and",
                "filters": [],
                "sort": [{"column": "name", "direction": "asc", "nulls": "last"}],
            },
        )

        row_id = engine.internal_row_id_column(indexed)
        assert isinstance(row_id, str)
        page = engine.page(
            ascending,
            0,
            10,
            total_rows=None,
            column_projection=[(0, "name-id")],
        )
        assert [row["values"][0]["display"] for row in page["rows"]] == [
            "ALPHA",
            "Beta",
            "Beta",
            "alpha",
            "ÄLPHA",
        ]
        identities = [row["id"] for row in page["rows"]]
        assert len(identities) == len(set(identities)) == 5
        assert page["totalRows"] == 5
    finally:
        engine.close()


def test_owned_source_pages_use_progressive_offset_without_inventing_a_total(
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "bounded-source-page")
    dataframe_type = type(indexed)

    original_offset = dataframe_type.offset
    offsets: list[int] = []

    def observed_offset(frame: Any, value: int) -> Any:
        offsets.append(value)
        return original_offset(frame, value)

    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(dataframe_type, "offset", observed_offset)
            first_page = engine.page(
                indexed,
                0,
                2,
                total_rows=None,
                column_projection=[(0, "name-id")],
            )
            page = engine.page(
                indexed,
                2,
                2,
                total_rows=None,
                column_projection=[(0, "name-id")],
            )
        assert offsets == [0, 1]
        assert [row["rowNumber"] for row in first_page["rows"]] == [0, 1]
        assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
        assert page["totalRows"] is None
        assert page["hasMore"] is True
        assert len({row["id"] for row in page["rows"]}) == 2
    finally:
        engine.close()


def test_projected_progressive_paging_filters_sorts_and_profiles_are_native_and_bounded(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    engine, indexed = _open_engine(sample_frame, "native")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("A forbidden dataframe conversion path was called.")

    def observed_collect(value: Any) -> Any:
        collected_projections.append(tuple(value.columns))
        return original_collect(value)

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)
    monkeypatch.setattr(dataframe_type, "collect", observed_collect)

    try:
        shape = engine.shape(indexed)
        assert shape == {"rows": None, "columns": 5}
        schema = engine.schema(indexed)
        assert [column["name"] for column in schema] == [
            "name",
            "amount",
            "group_name",
            "flag",
            "happened",
        ]
        assert [column["type"] for column in schema] == [
            "string",
            "float",
            "string",
            "boolean",
            "datetime",
        ]

        first_page = engine.page(
            indexed,
            0,
            2,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        page = engine.page(
            indexed,
            2,
            2,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert page["totalRows"] is None
        assert page["hasMore"] is True
        assert page["columnIds"] == ["amount-id", "name-id"]
        assert [row["rowNumber"] for row in first_page["rows"]] == [0, 1]
        assert [row["rowNumber"] for row in page["rows"]] == [2, 3]
        full_page = engine.page(
            indexed,
            0,
            10,
            total_rows=shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert full_page["totalRows"] == 5
        assert "hasMore" not in full_page
        assert first_page["rows"] == full_page["rows"][:2]
        assert page["rows"] == [
            {**row, "rowNumber": position} for position, row in enumerate(full_page["rows"][2:4], start=2)
        ]
        amount_by_name = {row["values"][1]["display"]: row["values"][0] for row in full_page["rows"]}
        assert amount_by_name["alpha"]["isNull"]
        assert amount_by_name["ALPHA"]["isNaN"]

        text_filter = {
            "logic": "and",
            "filters": [
                {
                    "column": "name",
                    "type": "string",
                    "logic": "and",
                    "predicates": [{"operator": "contains", "value": "AlPhA"}],
                }
            ],
            "sort": [],
        }
        text_view = engine.apply_filter_model(indexed, text_filter)
        text_shape = engine.shape(text_view)
        assert text_shape["rows"] is None
        text_page = engine.page(
            text_view,
            0,
            10,
            total_rows=text_shape["rows"],
            column_projection=[(0, "name-id")],
        )
        assert text_page["totalRows"] == 2
        assert [row["values"][0]["display"] for row in text_page["rows"]] == ["alpha", "ALPHA"]

        sorted_model = {
            "logic": "and",
            "filters": [
                {
                    "column": "amount",
                    "type": "float",
                    "logic": "and",
                    "predicates": [
                        {"operator": "isNotNull"},
                        {"operator": "isNotNaN"},
                    ],
                }
            ],
            "sort": [
                {
                    "column": "amount",
                    "direction": "asc",
                    "nulls": "last",
                }
            ],
        }
        sorted_view = engine.apply_filter_model(indexed, sorted_model)
        sorted_shape = engine.shape(sorted_view)
        sorted_page = engine.page(
            sorted_view,
            0,
            10,
            total_rows=sorted_shape["rows"],
            column_projection=[(1, "amount-id"), (0, "name-id")],
        )
        assert sorted_page["totalRows"] == 3
        assert [row["values"][0]["raw"] for row in sorted_page["rows"]] == [-1.0, 2.0, 2.0]
        assert [row["values"][1]["display"] for row in sorted_page["rows"]] == ["ÄLPHA", "Beta", "Beta"]

        summary = engine.summaries(indexed, [(1, "amount-id")])[0]
        assert summary["columnId"] == "amount-id"
        assert summary["totalCount"] == 5
        assert summary["nullCount"] == 1
        assert summary["nanCount"] == 1
        assert summary["distinctCount"] == 2
        assert summary["numeric"] == pytest.approx(
            {
                "min": -1.0,
                "max": 2.0,
                "mean": 1.0,
                "median": 2.0,
                "std": 3**0.5,
            }
        )
        assert summary["visualization"]["kind"] == "numeric"

        stats = engine.header_stats(indexed)
        assert stats == {
            "missingCells": 4,
            "missingRows": 2,
            "duplicateRows": 1,
            "missingValuesByColumn": [
                {"column": "name", "count": 0},
                {"column": "amount", "count": 2},
                {"column": "group_name", "count": 0},
                {"column": "flag", "count": 1},
                {"column": "happened", "count": 1},
            ],
        }

        values, has_more = engine.column_values(indexed, "name", "alp", 10)
        assert not has_more
        assert [(item["value"], item["count"]) for item in values] == [("ALPHA", 1), ("alpha", 1)]
        assert all("selectionValue" in item for item in values)
        assert collected_projections.count(("count", "__ow_value")) >= 2
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    # The adapter owns only its indexed cached child, never the user's session.
    assert spark_session.range(1).count() == 1


def test_partitioned_skewed_frame_keeps_native_progressive_paging_multi_sort_and_cleanup(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    functions = import_module("pyspark.sql.functions")
    row_count = 20_000
    hot_row_count = 19_400
    partition_count = 23
    source = (
        spark_session.range(row_count, numPartitions=partition_count)
        .select(
            functions.col("id").alias("record_id"),
            functions.when(functions.col("id") < hot_row_count, functions.lit("hot"))
            .otherwise(functions.concat(functions.lit("tail-"), functions.col("id").cast("string")))
            .alias("segment"),
            functions.when(
                (functions.col("id") % 97) == 0,
                functions.lit(None).cast("double"),
            )
            .otherwise((functions.col("id") % 1_000).cast("double"))
            .alias("score"),
        )
        .repartition(partition_count, "record_id")
    )
    assert source.select(functions.spark_partition_id().alias("partition_id")).distinct().count() == partition_count

    dataframe_type = type(source)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("Partitioned PySpark viewing must never use a dataframe conversion path.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    engine, indexed = _open_engine(source, "partitioned-skew")
    try:
        assert engine.shape(indexed) == {"rows": None, "columns": 3}
        with pytest.raises(EngineError, match="requested contiguously"):
            engine.page(
                indexed,
                row_count - 12,
                20,
                total_rows=None,
                column_projection=[(0, "record-id"), (1, "segment-id")],
            )
        with pytest.raises(EngineError, match="requested contiguously"):
            engine.page(
                indexed,
                row_count - 12,
                20,
                total_rows=row_count,
                column_projection=[(0, "record-id"), (1, "segment-id")],
            )
        first_source_page = engine.page(
            indexed,
            0,
            20,
            total_rows=None,
            column_projection=[(0, "record-id"), (1, "segment-id")],
        )
        second_source_page = engine.page(
            indexed,
            20,
            20,
            total_rows=None,
            column_projection=[(0, "record-id"), (1, "segment-id")],
        )
        assert first_source_page["columnIds"] == ["record-id", "segment-id"]
        assert [row["rowNumber"] for row in first_source_page["rows"]] == list(range(20))
        assert [row["rowNumber"] for row in second_source_page["rows"]] == list(range(20, 40))
        assert len({row["id"] for row in [*first_source_page["rows"], *second_source_page["rows"]]}) == 40
        assert first_source_page["totalRows"] is None
        assert second_source_page["totalRows"] is None

        model = {
            "logic": "and",
            "filters": [
                {
                    "column": "segment",
                    "type": "string",
                    "logic": "and",
                    "predicates": [{"operator": "equals", "value": "hot"}],
                }
            ],
            "sort": [
                {"column": "score", "direction": "asc", "nulls": "last"},
                {"column": "record_id", "direction": "desc", "nulls": "last"},
            ],
        }
        view = engine.apply_filter_model(indexed, model)
        assert engine.shape(view) == {"rows": None, "columns": 3}

        expected_ids = sorted(
            range(hot_row_count),
            key=lambda value: (
                value % 97 == 0,
                value % 1_000 if value % 97 != 0 else 0,
                -value,
            ),
        )
        first_page = engine.page(
            view,
            0,
            5,
            total_rows=None,
            column_projection=[(0, "record-id")],
        )
        second_page = engine.page(
            view,
            5,
            5,
            total_rows=None,
            column_projection=[(0, "record-id")],
        )
        assert [row["values"][0]["raw"] for row in first_page["rows"]] == expected_ids[:5]
        assert [row["values"][0]["raw"] for row in second_page["rows"]] == expected_ids[5:10]
        assert first_page["totalRows"] is None
        assert first_page["hasMore"] is True
        assert second_page["totalRows"] is None
        assert second_page["hasMore"] is True

        score_summary = engine.summaries(view, [(2, "score-id")])[0]
        assert score_summary["totalCount"] == hot_row_count
        assert score_summary["nullCount"] == 200
        assert score_summary["numeric"]["min"] == 0.0
        assert score_summary["numeric"]["max"] == 999.0
    finally:
        engine.close()

    # Closing Open Wrangler releases only its logical child, not the user's
    # Classic or Connect Spark session.
    assert spark_session.range(1).count() == 1


def test_numeric_histogram_is_exact_for_a_large_filtered_view(spark_session: Any) -> None:
    functions = import_module("pyspark.sql.functions")
    source = (
        spark_session.range(5_000)
        .select(functions.col("id").cast("double").alias("value"))
        .unionByName(spark_session.createDataFrame([(1_000_000.0,)], "value double"))
    )
    engine = PySparkEngine()
    try:
        frame = engine.apply_filter_model(
            source,
            {
                "logic": "and",
                "filters": [
                    {
                        "column": "value",
                        "type": "float",
                        "logic": "and",
                        "predicates": [{"operator": "gte", "value": 500}],
                    }
                ],
                "sort": [],
            },
        )

        summary = engine.summaries(frame, [(0, "value-id")])[0]
        bins = summary["visualization"]["bins"]

        assert summary["numeric"]["min"] == 500.0
        assert summary["numeric"]["max"] == 1_000_000.0
        assert "sampled" not in summary["visualization"]
        assert len(bins) == 20
        assert bins[0]["min"] == summary["numeric"]["min"]
        assert bins[-1]["max"] == summary["numeric"]["max"]
        assert bins[-1]["count"] == 1
        assert sum(bin_["count"] for bin_ in bins) == 4_501
        assert all(left["max"] == right["min"] for left, right in zip(bins, bins[1:], strict=False))
        assert [bin_["max"] - bin_["min"] for bin_ in bins] == pytest.approx(
            [bins[0]["max"] - bins[0]["min"]] * len(bins)
        )
    finally:
        engine.close()


def test_numeric_summaries_publish_lossless_wide_integer_and_decimal_extrema(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.createDataFrame(
        [
            (-9_007_199_254_740_993, Decimal("-123456789012345.123456789012345678")),
            (9_007_199_254_740_995, Decimal("987654321098765.987654321098765432")),
        ],
        "wide long, amount decimal(38,18)",
    )
    engine, indexed = _open_engine(frame, "exact-extrema")
    dataframe_type = type(indexed)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("PySpark summaries must never convert through Pandas or Arrow.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    try:
        summaries = engine.summaries(indexed, [(0, "wide-id"), (1, "amount-id")])

        assert summaries[0]["numeric"]["exactMin"] == {
            "kind": "integer",
            "raw": "-9007199254740993",
            "display": "-9007199254740993",
            "isNull": False,
            "isNaN": False,
        }
        assert summaries[0]["numeric"]["exactMax"] == {
            "kind": "integer",
            "raw": "9007199254740995",
            "display": "9007199254740995",
            "isNull": False,
            "isNaN": False,
        }
        assert summaries[1]["numeric"]["exactMin"]["display"] == "-123456789012345.123456789012345678"
        assert summaries[1]["numeric"]["exactMax"]["display"] == "987654321098765.987654321098765432"
        assert summaries[1]["numeric"]["exactMin"]["kind"] == "decimal"
        assert summaries[1]["numeric"]["exactMax"]["kind"] == "decimal"
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_text_summaries_are_exact_native_unicode_aggregates(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.createDataFrame(
        [
            (None, None),
            ("", None),
            ("A", None),
            ("é", None),
            ("e\u0301", None),
            ("😀", None),
        ],
        "text_value string, all_null string",
    )
    engine, indexed = _open_engine(frame, "text-summary")
    dataframe_type = type(indexed)

    def forbidden(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("PySpark summaries must never convert through Pandas or Arrow.")

    for method_name in ("toPandas", "toArrow", "mapInPandas", "mapInArrow"):
        if hasattr(dataframe_type, method_name):
            monkeypatch.setattr(dataframe_type, method_name, forbidden)

    try:
        summaries = engine.summaries(indexed, [(0, "text-id"), (1, "all-null-id")])

        assert summaries[0]["text"] == pytest.approx(
            {
                "emptyCount": 1,
                "minLength": 0,
                "maxLength": 2,
                "meanLength": 1.0,
            }
        )
        assert summaries[0]["nullCount"] == 1
        assert summaries[1]["text"] == {"emptyCount": 0}
        assert summaries[1]["nullCount"] == 6
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_maps_and_nested_maps_use_canonical_native_profile_keys(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT
          map_from_arrays(array('a', 'b'), array(1, 2)) AS payload,
          named_struct(
            'nested',
            map_from_arrays(
              array('x'),
              array(map_from_arrays(array('a', 'b'), array(1, 2)))
            )
          ) AS detail
        UNION ALL
        SELECT
          map_from_arrays(array('b', 'a'), array(2, 1)) AS payload,
          named_struct(
            'nested',
            map_from_arrays(
              array('x'),
              array(map_from_arrays(array('b', 'a'), array(2, 1)))
            )
          ) AS detail
        UNION ALL
        SELECT
          map('a', 9) AS payload,
          named_struct('nested', map('x', map('a', 9))) AS detail
        """
    )
    engine, indexed = _open_engine(frame, "map-profiles")
    try:
        assert engine.header_stats(indexed) == {
            "missingCells": 0,
            "missingRows": 0,
            "duplicateRows": 1,
            "missingValuesByColumn": [
                {"column": "payload", "count": 0},
                {"column": "detail", "count": 0},
            ],
        }

        payload_summary = engine.summaries(indexed, [(0, "payload-id")])[0]
        assert payload_summary["distinctCount"] == 2
        assert payload_summary["topValues"] == [
            {"value": '{"a":1,"b":2}', "count": 2},
            {"value": '{"a":9}', "count": 1},
        ]
        values, has_more = engine.column_values(indexed, "payload", limit=10)
        assert not has_more
        assert values == [
            {"value": '{"a":1,"b":2}', "count": 2},
            {"value": '{"a":9}', "count": 1},
        ]

        page = engine.page(
            indexed,
            0,
            3,
            total_rows=3,
            column_projection=[(0, "payload-id"), (1, "detail-id")],
        )
        assert page["columnIds"] == ["payload-id", "detail-id"]
        assert page["rows"][0]["values"][0]["raw"] == {"a": 1, "b": 2}
        assert page["rows"][1]["values"][0]["raw"] == {"b": 2, "a": 1}
        assert page["rows"][0]["values"][1]["raw"] == {"nested": {"x": {"a": 1, "b": 2}}}
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_nested_decimals_keep_exact_page_precision(spark_session: Any) -> None:
    exact = "12345678901234567890.123456789012345678"
    frame = spark_session.sql(
        f"""
        SELECT named_struct(
          'amount', CAST('{exact}' AS DECIMAL(38, 18)),
          'items', array(CAST('{exact}' AS DECIMAL(38, 18))),
          'by_key', map('x', CAST('{exact}' AS DECIMAL(38, 18)))
        ) AS payload
        """
    )
    engine, indexed = _open_engine(frame, "nested-decimal-page")
    try:
        page = engine.page(
            indexed,
            0,
            1,
            total_rows=1,
            column_projection=[(0, "payload-id")],
        )
        assert page["rows"][0]["values"][0]["raw"] == {
            "amount": exact,
            "items": [exact],
            "by_key": {"x": exact},
        }
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_nested_negative_zero_uses_native_profile_equality(spark_session: Any) -> None:
    frame = spark_session.sql(
        """
        SELECT
          array(CAST('-0.0' AS DOUBLE)) AS array_value,
          map('x', CAST('-0.0' AS DOUBLE)) AS map_value,
          named_struct('x', CAST('-0.0' AS DOUBLE)) AS struct_value
        UNION ALL
        SELECT
          array(CAST('0.0' AS DOUBLE)),
          map('x', CAST('0.0' AS DOUBLE)),
          named_struct('x', CAST('0.0' AS DOUBLE))
        """
    )
    engine, indexed = _open_engine(frame, "nested-negative-zero")
    try:
        for position, column_name in enumerate(("array_value", "map_value", "struct_value")):
            summary = engine.summaries(indexed, [(position, f"{column_name}-id")])[0]
            assert summary["distinctCount"] == 1
            assert len(summary["topValues"]) == 1
            assert summary["topValues"][0]["count"] == 2

            values, has_more = engine.column_values(indexed, column_name, limit=10)
            assert not has_more
            assert len(values) == 1
            assert values[0]["count"] == 2
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


@pytest.mark.parametrize(
    "expression",
    [
        "repeat('x', 128)",
        "encode(repeat('x', 128), 'UTF-8')",
        "array_repeat(repeat('x', 8), 32)",
        "map('payload', repeat('x', 128))",
        "named_struct('payload', repeat('x', 128))",
    ],
)
def test_large_variable_width_page_values_use_one_guarded_terminal_collection(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
    expression: str,
) -> None:
    frame = spark_session.sql(f"SELECT {expression} AS payload")
    engine, indexed = _open_engine(frame, "large-page-value")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    transported_payloads: list[Any] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        rows = original_collect(value)
        if "__ow_page_value_bytes" in projection:
            payload_index = projection.index("__ow_page_value_0")
            transported_payloads.extend(row[payload_index] for row in rows)
        return rows

    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_TRANSPORT_BYTE_LIMIT", 32)
            page_patch.setattr(dataframe_type, "collect", guarded_collect)
            with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(0, "payload-id")],
                )
        assert collected_projections == [("__ow_page_row_id", "__ow_page_value_bytes", "__ow_page_value_0")]
        assert transported_payloads == [None]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_large_profile_values_fail_before_terminal_collection(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.sql(
        """
        SELECT
          repeat('x', 128) AS text_value,
          encode(repeat('x', 128), 'UTF-8') AS binary_value,
          array_repeat(repeat('x', 8), 32) AS array_value,
          map('payload', repeat('x', 128)) AS map_value,
          named_struct('payload', repeat('x', 128)) AS struct_value
        """
    )
    engine, indexed = _open_engine(frame, "large-profile-values")
    dataframe_type = type(indexed)
    original_collect = dataframe_type.collect
    collected_projections: list[tuple[str, ...]] = []

    def guarded_collect(value: Any) -> Any:
        projection = tuple(value.columns)
        collected_projections.append(projection)
        if "__ow_value" in projection:
            raise AssertionError("Oversized profile values must not cross into the notebook process.")
        return original_collect(value)

    try:
        with monkeypatch.context() as profile_patch:
            profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_TRANSPORT_BYTE_LIMIT", 32)
            profile_patch.setattr(dataframe_type, "collect", guarded_collect)
            for position, column_name in enumerate(
                ("text_value", "binary_value", "array_value", "map_value", "struct_value")
            ):
                with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                    engine.summaries(indexed, [(position, f"{column_name}-id")])
                with pytest.raises(EngineError, match=r"at most 32 UTF-8 bytes"):
                    engine.column_values(indexed, column_name, limit=10)
        assert collected_projections.count(("__ow_profile_value_bytes",)) == 10
        assert all("__ow_value" not in projection for projection in collected_projections)
        assert all("__ow_group_key" not in projection for projection in collected_projections)
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_complex_page_depth_and_node_budgets_are_authoritative(
    spark_session: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    frame = spark_session.sql("SELECT array(array(array(1))) AS nested, array(1, 2, 3, 4) AS many")
    engine, indexed = _open_engine(frame, "complex-page-budgets")
    try:
        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_COMPLEX_DEPTH_LIMIT", 2)
            with pytest.raises(EngineError, match=r"at most 2 nested levels; encountered depth 3"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(0, "nested-id")],
                )

        with monkeypatch.context() as page_patch:
            page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_COMPLEX_NODE_LIMIT", 4)
            with pytest.raises(EngineError, match=r"at most 4 JSON nodes; encountered at least 5"):
                engine.page(
                    indexed,
                    0,
                    1,
                    total_rows=1,
                    column_projection=[(1, "many-id")],
                )

        page = engine.page(
            indexed,
            0,
            1,
            total_rows=1,
            column_projection=[(0, "nested-id"), (1, "many-id")],
        )
        assert page["rows"][0]["values"][0]["raw"] == [[[1]]]
        assert page["rows"][0]["values"][1]["raw"] == [1, 2, 3, 4]
    finally:
        engine.close()

    assert spark_session.range(1).count() == 1


def test_page_protocol_byte_budget_accepts_only_the_exact_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = {
        "offset": 0,
        "limit": 1,
        "totalRows": 1,
        "columnIds": ["payload-id"],
        "rows": [
            {
                "id": "r:0",
                "rowNumber": 0,
                "values": [
                    {
                        "kind": "string",
                        "raw": 'quoted "value"',
                        "display": 'quoted "value"',
                        "isNull": False,
                        "isNaN": False,
                    }
                ],
            }
        ],
    }
    exact_size = len(json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    with monkeypatch.context() as page_patch:
        page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT", exact_size)
        pyspark_engine_module._validate_page_protocol_size(page)

    with monkeypatch.context() as page_patch:
        page_patch.setattr(pyspark_engine_module, "PYSPARK_PAGE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
        with pytest.raises(EngineError, match=rf"at most {exact_size - 1:,} serialized bytes"):
            pyspark_engine_module._validate_page_protocol_size(page)


def test_profile_protocol_byte_budget_accepts_only_the_exact_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = [{"value": 'quoted "value"', "count": 1}]
    exact_size = len(json.dumps(values, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    with monkeypatch.context() as profile_patch:
        profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_PROTOCOL_BYTE_LIMIT", exact_size)
        pyspark_engine_module._validate_profile_protocol_size(values, "column values")

    with monkeypatch.context() as profile_patch:
        profile_patch.setattr(pyspark_engine_module, "PYSPARK_PROFILE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
        with pytest.raises(EngineError, match=rf"at most {exact_size - 1:,} serialized bytes"):
            pyspark_engine_module._validate_profile_protocol_size(values, "column values")


def test_session_manager_detects_live_variable_and_disables_mutation_capabilities(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(__main__, "open_wrangler_spark_frame", sample_frame, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "variableName": "open_wrangler_spark_frame",
            "label": "open_wrangler_spark_frame",
        },
        page_size=2,
        mode="editing",
        column_limit=2,
    )
    metadata = opened["metadata"]
    assert metadata["backend"] == "pyspark"
    assert metadata["mode"] == "viewing"
    assert metadata["capabilities"] == {
        "editable": False,
        "lazy": False,
        "cancel": False,
        "exportCsv": False,
        "exportParquet": False,
        "notebookInsert": False,
    }
    assert opened["page"]["columnIds"] == ["c:source:0", "c:source:1"]
    assert len(opened["page"]["rows"]) == 2
    assert metadata["shape"] == {"rows": None, "columns": 5}
    assert metadata["filteredShape"] == {"rows": None, "columns": 5}
    assert opened["page"]["totalRows"] is None
    assert opened["page"]["hasMore"] is True

    middle = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        2,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert middle["page"]["totalRows"] is None
    assert middle["page"]["hasMore"] is True

    terminal = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        4,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert terminal["page"]["totalRows"] == 5
    assert "hasMore" not in terminal["page"]
    assert terminal["metadata"]["shape"] == {"rows": 5, "columns": 5}
    assert terminal["metadata"]["filteredShape"] == {"rows": 5, "columns": 5}

    first_again = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        0,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert first_again["page"]["totalRows"] == 5
    assert "hasMore" not in first_again["page"]

    middle_again = manager.get_page(
        metadata["sessionId"],
        metadata["revision"],
        2,
        2,
        _empty_view(),
        column_limit=2,
    )
    assert middle_again["page"]["totalRows"] == 5
    assert [row["rowNumber"] for row in middle_again["page"]["rows"]] == [2, 3]

    with pytest.raises(EngineError, match="viewing mode"):
        manager.preview_step(
            metadata["sessionId"],
            metadata["revision"],
            {"id": "step", "kind": "dropDuplicates", "params": {}},
            0,
            10,
        )
    assert manager.close_session(metadata["sessionId"], metadata["revision"]) == {
        "kind": "sessionClosed",
        "sessionId": metadata["sessionId"],
    }
    assert manager.sessions == {}
    assert spark_session.range(1).count() == 1


def test_terminal_close_never_enters_pyspark_request_ownership() -> None:
    contexts = (_StoppedSparkContext(), _RestoreFailingSparkContext())
    for index, spark_context in enumerate(contexts):
        session_id = f"close-without-spark-scope-{index}"
        engine = PySparkEngine()
        engine._indexed_frame = _FakeClassicFrame(spark_context)
        session = _ClosablePySparkSession(session_id, engine)
        manager = SessionManager()
        manager.sessions[session_id] = session  # type: ignore[assignment]

        response = server.dispatch(
            manager,
            {"kind": "closeSession", "sessionId": session_id, "revision": 0},
            f"close-request-{index}",
        )

        assert response == {"kind": "sessionClosed", "sessionId": session_id}
        assert spark_context.ownership_calls == 0
        assert session.disposed
        assert manager.sessions == {}


def test_replacing_classic_or_connect_variable_invalidates_cached_pages_before_read(
    spark_session: Any,
    sample_frame: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    variable_name = "open_wrangler_replaced_spark_frame"
    monkeypatch.setattr(__main__, variable_name, sample_frame, raising=False)
    manager = SessionManager()
    opened = manager.open_session(
        {
            "kind": "notebookVariable",
            "variableName": variable_name,
            "label": variable_name,
        },
        backend="pyspark",
        page_size=2,
        column_limit=2,
    )
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    assert session.live_source_value is sample_frame
    assert len(session.page_cache) == 1

    replacement = spark_session.range(10, 13).selectExpr("id AS replacement_value")
    monkeypatch.setattr(__main__, variable_name, replacement)
    with pytest.raises(LiveSourceInvalidatedError, match="was replaced") as invalidated:
        manager.get_page(
            session_id,
            0,
            0,
            2,
            {"logic": "and", "filters": [], "sort": []},
            column_limit=2,
        )

    assert invalidated.value.session_id == session_id
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0
    assert manager.close_session(session_id, 0) == {"kind": "sessionClosed", "sessionId": session_id}
    assert replacement.count() == 3
