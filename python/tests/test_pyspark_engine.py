from __future__ import annotations

import json
import re
import signal
import threading
from collections.abc import Mapping
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from importlib import import_module
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from python.tests.pyspark_connect_test_support import (
    FakeConnectFrame as _FakeConnectFrame,
)
from python.tests.pyspark_connect_test_support import (
    FakeSparkConnectError as _FakeSparkConnectError,
)
from python.tests.pyspark_engine_test_support import (
    _empty_view,
    _FailureClassifyingSession,
    _FakeClassicFrame,
    _FakeSparkContext,
    _open_engine,
    _StoppedSparkContext,
    _ThreadLocalFakeSparkContext,
)
from python.tests.pyspark_engine_test_support import (
    sample_frame as _shared_sample_frame,
)
from python.tests.pyspark_engine_test_support import (
    spark_session as _shared_spark_session,
)

import __main__
import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
import openwrangler_runtime.kernel_agent as kernel_agent
import openwrangler_runtime.server as server
import openwrangler_runtime.session as session_runtime
from openwrangler_runtime.engines import EngineError, PySparkEngine
from openwrangler_runtime.engines.base import INTERNAL_ROW_ID_PREFIX
from openwrangler_runtime.pyspark_version_policy_generated import (
    classify_pyspark_version,
    safe_pyspark_version_diagnostic,
)
from openwrangler_runtime.session import (
    PySparkConnectStateLostError,
    PySparkConnectUnavailableError,
    Session,
    SessionManager,
)
from openwrangler_runtime.session_source import LiveSourceInvalidatedError, SessionSource

sample_frame = _shared_sample_frame
spark_session = _shared_spark_session

_PYSPARK_VERSION_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "pyspark-version-contract.json").read_text(encoding="utf-8")
)
_REJECTED_PYSPARK_VERSIONS = [
    ("acceptancePrereleaseDenial", version) for version in _PYSPARK_VERSION_CONTRACT["acceptancePrereleaseDenial"]
] + [
    (category, version) for category, versions in _PYSPARK_VERSION_CONTRACT["rejected"].items() for version in versions
]


def test_strict_pyspark_version_contract() -> None:
    assert all(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for version in _PYSPARK_VERSION_CONTRACT["acceptedFinal"]
    )
    assert not any(
        pyspark_engine_module._is_supported_pyspark_version(version)
        for _category, version in _REJECTED_PYSPARK_VERSIONS
    )
    assert all(
        classify_pyspark_version(version) == "supported-final" for version in _PYSPARK_VERSION_CONTRACT["acceptedFinal"]
    )
    assert all(
        classify_pyspark_version(version) == "acceptance-denial"
        for version in _PYSPARK_VERSION_CONTRACT["acceptancePrereleaseDenial"]
    )
    assert all(
        classify_pyspark_version(version) == "unsupported"
        for versions in _PYSPARK_VERSION_CONTRACT["rejected"].values()
        for version in versions
    )


def test_generated_pyspark_version_diagnostics_are_exactly_bounded_and_printable() -> None:
    assert safe_pyspark_version_diagnostic("x" * 64) == "x" * 64
    for version in ("x" * 65, "4.2.0\n", "4.2.0\t", "4.2.0\x00", "4.2.0-β", None, 420):
        assert safe_pyspark_version_diagnostic(version) is None


@pytest.mark.parametrize("version", _PYSPARK_VERSION_CONTRACT["acceptedFinal"])
def test_runtime_gate_accepts_final_pyspark_versions(monkeypatch: pytest.MonkeyPatch, version: str) -> None:
    class FinalFrame:
        isStreaming = False
        schema = SimpleNamespace(fields=[])

        def withColumn(self, _name: str, _expression: object) -> None:
            return None

    monkeypatch.setattr(pyspark_engine_module, "import_module", lambda name: SimpleNamespace(__version__=version))

    PySparkEngine._require_supported_frame(FinalFrame())


@pytest.mark.parametrize(
    ("_category", "version"),
    _REJECTED_PYSPARK_VERSIONS,
    ids=[f"{category}-{index}" for index, (category, _version) in enumerate(_REJECTED_PYSPARK_VERSIONS)],
)
def test_runtime_gate_rejects_nonfinal_pyspark_versions_before_frame_use(
    monkeypatch: pytest.MonkeyPatch, _category: str, version: str
) -> None:
    class UnqualifiedFrame:
        @property
        def isStreaming(self) -> None:
            raise AssertionError("An unqualified PySpark build must fail before isStreaming is inspected.")

        @property
        def columns(self) -> None:
            raise AssertionError("An unqualified PySpark build must fail before columns are inspected.")

        @property
        def schema(self) -> None:
            raise AssertionError("An unqualified PySpark build must fail before schema is inspected.")

        @property
        def withColumn(self) -> None:
            raise AssertionError("An unqualified PySpark build must fail before dataframe operations are inspected.")

    monkeypatch.setattr(pyspark_engine_module, "import_module", lambda name: SimpleNamespace(__version__=version))

    with pytest.raises(EngineError, match="requires a final PySpark 4[.]2[.]x release"):
        PySparkEngine._require_supported_frame(UnqualifiedFrame())

    with pytest.raises(EngineError, match="requires a final PySpark 4[.]2[.]x release"):
        PySparkEngine().validate_internal_row_id_namespace(UnqualifiedFrame())


@pytest.mark.parametrize("version", ["4.2.0\n", "4.2.0\x00", "x" * 65])
def test_runtime_version_diagnostics_are_bounded_and_do_not_embed_rejected_input(
    monkeypatch: pytest.MonkeyPatch, version: str
) -> None:
    monkeypatch.setattr(pyspark_engine_module, "import_module", lambda name: SimpleNamespace(__version__=version))

    with pytest.raises(EngineError) as captured:
        PySparkEngine().validate_runtime()

    message = str(captured.value)
    assert message == (
        "Open Wrangler requires a final PySpark 4.2.x release for notebook viewing. "
        "Install a supported final release in the selected kernel, restart it, and rerun the defining cell."
    )
    assert version not in message


def test_runtime_rejects_unqualified_pyspark_before_notebook_namespace_resolution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    version = "4.2.0.dev1"
    monkeypatch.setattr(pyspark_engine_module, "import_module", lambda name: SimpleNamespace(__version__=version))
    manager = SessionManager()
    resolution_calls = 0

    def fail_resolution(_source: Mapping[str, Any]) -> Any:
        nonlocal resolution_calls
        resolution_calls += 1
        raise AssertionError("An unqualified PySpark runtime must fail before resolving the notebook namespace.")

    monkeypatch.setattr(session_runtime, "resolve_notebook_variable", fail_resolution)

    with pytest.raises(EngineError, match="requires a final PySpark 4[.]2[.]x release") as captured:
        manager.open_session(
            {"kind": "notebookVariable", "variableName": "spark_frame", "label": "spark_frame"},
            backend="pyspark",
        )

    assert version not in str(captured.value)
    assert resolution_calls == 0
    assert manager.sessions == {}


def test_clone_open_rechecks_pyspark_version_before_any_frame_access(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    accesses: list[str] = []

    class UnqualifiedFrame:
        @property
        def columns(self) -> None:
            accesses.append("columns")
            raise AssertionError("The clone must qualify PySpark before reading columns.")

        @property
        def isStreaming(self) -> None:
            accesses.append("isStreaming")
            raise AssertionError("The clone must qualify PySpark before reading isStreaming.")

        @property
        def schema(self) -> None:
            accesses.append("schema")
            raise AssertionError("The clone must qualify PySpark before reading schema.")

        @property
        def withColumn(self) -> None:
            accesses.append("withColumn")
            raise AssertionError("The clone must qualify PySpark before reading withColumn.")

    source = {"kind": "notebookVariable", "variableName": "spark_frame", "label": "spark_frame"}
    source_owner = SessionSource.capture("confirmed-spark", source, PySparkEngine())
    source_owner.bind_loaded_value(PySparkEngine(), UnqualifiedFrame())
    source_session = SimpleNamespace(
        backend="pyspark",
        disposed=False,
        mode="viewing",
        original=UnqualifiedFrame(),
        revision=0,
        source=source_owner,
    )
    manager = SessionManager()
    manager.sessions["confirmed-spark"] = cast(Session, source_session)
    monkeypatch.setattr(manager, "_exclusive_session_read", lambda _session: nullcontext())
    monkeypatch.setattr(manager.registry, "create", lambda _backend: PySparkEngine())
    monkeypatch.setattr(
        pyspark_engine_module,
        "import_module",
        lambda name: SimpleNamespace(__version__="4.2.0.dev5"),
    )

    with pytest.raises(EngineError, match="requires a final PySpark 4[.]2[.]x release"):
        manager.open_session(
            source,
            backend="pyspark",
            requested_session_id="clone-spark",
            clone_from={"sessionId": "confirmed-spark", "revision": 0},
        )

    assert accesses == []
    assert set(manager.sessions) == {"confirmed-spark"}


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
    with pytest.raises(EngineError, match="viewing-only"):
        engine.apply_transform(object(), {})
    with pytest.raises(EngineError, match="do not generate"):
        engine.compile_plan(())
    with pytest.raises(EngineError, match="do not export"):
        engine.export_data(object(), "cleaned.parquet", {"format": "parquet"})


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


def test_connect_request_failure_requires_connect_and_safe_structured_accessors() -> None:
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(_FakeSparkContext())
    lost = _FakeSparkConnectError(condition="INVALID_HANDLE.SESSION_NOT_FOUND")
    assert engine.classify_request_failure(lost) is None

    engine._indexed_frame = _FakeConnectFrame()
    assert engine.classify_request_failure(_FakeSparkConnectError(accessors_fail=True)) is None


@pytest.mark.parametrize(
    ("error", "expected_error", "cache_cleared"),
    (
        (
            _FakeSparkConnectError(status_name="UNAVAILABLE"),
            PySparkConnectUnavailableError,
            False,
        ),
        (
            _FakeSparkConnectError(condition="INVALID_HANDLE.SESSION_NOT_FOUND"),
            PySparkConnectStateLostError,
            True,
        ),
    ),
    ids=("temporarily-unavailable", "state-lost"),
)
def test_manager_preserves_connect_session_and_reports_structured_failure(
    error: Exception,
    expected_error: type[Exception],
    cache_cleared: bool,
) -> None:
    session_id = "connect-session"
    engine = PySparkEngine()
    engine._indexed_frame = _FakeConnectFrame()
    session = _FailureClassifyingSession(session_id, engine)
    manager = SessionManager()
    manager.sessions[session_id] = session  # type: ignore[assignment]
    source_before = dict(session.source.metadata)

    with (
        pytest.raises(expected_error, match="current Open Wrangler view is unchanged") as classified,
        manager.request_scope(
            "connect-request",
            {"kind": "getPage", "sessionId": session_id},
        ),
    ):
        raise error

    assert classified.value.session_id == session_id  # type: ignore[attr-defined]
    assert manager.sessions[session_id] is session
    assert session.source.metadata == source_before
    assert session.disposed is False
    assert (session.page_cache == {}) is cache_cleared
    assert session.page_cache_bytes == (0 if cache_cleared else 128)


def test_rebound_classic_source_is_checked_before_request_ownership(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original = object()
    replacement = object()
    monkeypatch.setattr(__main__, "orders", replacement, raising=False)

    spark_context = _StoppedSparkContext()
    engine = PySparkEngine()
    engine._indexed_frame = _FakeClassicFrame(spark_context)
    session = _FailureClassifyingSession("classic-session", engine, original)
    manager = SessionManager()
    manager.sessions[session.session_id] = session  # type: ignore[assignment]

    with pytest.raises(LiveSourceInvalidatedError, match="was replaced") as invalidated:
        server.dispatch(
            manager,
            {
                "kind": "getPage",
                "sessionId": session.session_id,
                "revision": 0,
                "viewRequestId": "classic-rebound-view",
                "offset": 0,
                "limit": 20,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": _empty_view(),
            },
            "classic-rebound-request",
        )

    assert invalidated.value.session_id == session.session_id
    assert spark_context.ownership_calls == 0
    assert session.page_cache == {}
    assert session.page_cache_bytes == 0


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

            def current_task_job_group(_value: int) -> str | None:
                # Spark workers cannot import pytest's top-level test module.
                # Keep the probe local so cloudpickle sends its small body.
                task_context = import_module("pyspark").TaskContext.get()
                assert task_context is not None
                return task_context.getLocalProperty("spark.jobGroup.id")

            for key, value in caller.items():
                spark_context.setLocalProperty(key, value)
            observed_groups: list[str | None] = []
            for request_id in (
                "bfe034be-1ad6-4893-945b-c50c75ed6c4f",
                "5ccb22a4-5f31-4ee0-95eb-4bf165a13ee9",
            ):
                with engine.request_scope(request_id):
                    observed_groups.extend(spark_context.parallelize([0], 1).map(current_task_job_group).collect())
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


@pytest.mark.parametrize(
    ("case", "message"),
    [
        (
            "duplicate",
            "The PySpark dataframe has conflicting columns 'value' and 'value'. Rename them in Spark with toDF() "
            "so every column name is unique when case is ignored.",
        ),
        (
            "casefold",
            "The PySpark dataframe has conflicting columns 'Value' and 'value'. Rename them in Spark with toDF() "
            "so every column name is unique when case is ignored.",
        ),
        (
            "private",
            f"The PySpark dataframe has a reserved Open Wrangler column name: "
            f"'{INTERNAL_ROW_ID_PREFIX.upper()}user'. Rename it in Spark with withColumnRenamed() before opening "
            "the dataframe.",
        ),
        (
            "streaming",
            "This PySpark dataframe is streaming. Write the stream to a table or files, then open a static "
            "dataframe read from that output.",
        ),
        (
            "missing-projection",
            "PySpark value type MissingProjectionFrame does not support Spark's withColumn() operation. Assign "
            "frame.select('*') to a new variable in Spark and open that variable.",
        ),
    ],
)
def test_rejects_unsupported_open_shapes_with_actionable_messages(
    spark_session: Any,
    case: str,
    message: str,
) -> None:
    class MissingProjectionFrame:
        isStreaming = False

    engine = PySparkEngine()
    if case == "duplicate":
        frame = spark_session.createDataFrame([(1, 2)], ["value", "value"])
        validate = engine.validate_column_addressability
    elif case == "casefold":
        frame = spark_session.createDataFrame([(1, 2)], ["Value", "value"])
        validate = engine.validate_column_addressability
    elif case == "private":
        frame = spark_session.createDataFrame([(1,)], [f"{INTERNAL_ROW_ID_PREFIX.upper()}user"])
        validate = engine.validate_internal_row_id_namespace
    elif case == "streaming":
        frame = spark_session.readStream.format("rate").load()
        validate = engine.validate_column_addressability
    else:
        frame = MissingProjectionFrame()
        validate = engine.validate_column_addressability

    with pytest.raises(EngineError) as captured:
        validate(frame)
    assert str(captured.value) == message


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

    monkeypatch.setattr(kernel_agent, "_manager", manager)
    envelope = json.dumps(
        {
            "protocolVersion": 2,
            "requestId": "unsupported-variant-open",
            "priority": "interactive",
            "request": {
                "kind": "openSession",
                "source": {
                    "kind": "notebookVariable",
                    "variableName": "open_wrangler_variant_frame",
                    "label": "open_wrangler_variant_frame",
                },
                "requestedSessionId": "unsupported-variant-candidate",
                "backend": "pyspark",
                "mode": "viewing",
                "pageSize": 20,
                "columnOffset": 0,
                "columnLimit": 16,
            },
        }
    )
    response = json.loads(kernel_agent.dispatch_json(envelope))
    assert response == {
        "protocolVersion": 2,
        "requestId": "unsupported-variant-open",
        "response": {
            "kind": "error",
            "code": "engine_error",
            "message": (
                "Open Wrangler cannot open this PySpark dataframe because required viewing profiles "
                "are unavailable for 'payload' (variant). Convert these columns in Spark to strings or another "
                "orderable Spark SQL type before opening them in Open Wrangler."
            ),
            "recoverable": True,
        },
    }
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
    monkeypatch.setattr(PySparkEngine, "validate_runtime", lambda _self: None)
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
