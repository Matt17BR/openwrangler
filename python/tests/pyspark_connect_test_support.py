from __future__ import annotations

import multiprocessing
import os
import queue
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from importlib import import_module
from types import SimpleNamespace
from typing import Any

import pytest

_LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS = 120


class FakeConnectFrame:
    def __init__(self) -> None:
        self.sparkSession = SimpleNamespace()


FakeConnectFrame.__module__ = "pyspark.sql.connect.dataframe"


class FakeSparkConnectError(Exception):
    def __init__(
        self,
        *,
        condition: str | None = None,
        parameters: Mapping[str, str] | None = None,
        status_name: str | None = None,
        accessors_fail: bool = False,
    ) -> None:
        super().__init__(condition or status_name or "Spark Connect request failed")
        self.condition = condition
        self.parameters = parameters
        self.status_name = status_name
        self.accessors_fail = accessors_fail

    def getCondition(self) -> str | None:
        if self.accessors_fail:
            raise RuntimeError("condition unavailable")
        return self.condition

    def getMessageParameters(self) -> Mapping[str, str] | None:
        if self.accessors_fail:
            raise RuntimeError("parameters unavailable")
        return self.parameters

    def getGrpcStatusCode(self) -> Any:
        if self.accessors_fail:
            raise RuntimeError("status unavailable")
        return SimpleNamespace(name=self.status_name) if self.status_name else None


FakeSparkConnectError.__module__ = "pyspark.errors.exceptions.connect"


@contextmanager
def scoped_spark_testing() -> Iterator[None]:
    had_spark_testing = "SPARK_TESTING" in os.environ
    previous_spark_testing = os.environ.get("SPARK_TESTING")
    # PySpark 4.2 uses an OS-bound ephemeral Connect port whenever this variable is present.
    os.environ["SPARK_TESTING"] = "1"
    try:
        yield
    finally:
        if had_spark_testing:
            assert previous_spark_testing is not None
            os.environ["SPARK_TESTING"] = previous_spark_testing
        else:
            os.environ.pop("SPARK_TESTING", None)


@contextmanager
def local_connect_session() -> Iterator[Any]:
    SparkSession = import_module("pyspark.sql").SparkSession
    spark: Any | None = None
    with scoped_spark_testing():
        try:
            spark = SparkSession.builder.remote("local[2]").getOrCreate()
            assert spark is not None
            spark.conf.set("spark.sql.shuffle.partitions", "2")
            yield spark
        finally:
            if spark is not None:
                spark.stop()
                connect_session = type(spark)
                classic_session = import_module("pyspark.sql.session").SparkSession
                assert spark.is_stopped
                assert connect_session._default_session is None
                assert getattr(connect_session._active_session, "session", None) is None
                assert classic_session._instantiatedSession is None
                assert classic_session._activeSession is None


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
        with local_connect_session() as spark:
            yield spark
        return
    try:
        yield spark
    finally:
        spark.stop()


def _run_local_connect_owner(
    owner: str,
    startup_barrier: Any,
    owners_live_barrier: Any,
    reports: Any,
) -> None:
    had_spark_testing = "SPARK_TESTING" in os.environ
    previous_spark_testing = os.environ.get("SPARK_TESTING")
    os.environ.pop("SPARK_TESTING", None)
    try:
        startup_barrier.wait(timeout=_LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS)
        with local_connect_session() as spark:
            assert os.environ.get("SPARK_TESTING") == "1"
            assert spark.range(8).count() == 8
            reports.put(("ready", owner, None))
            owners_live_barrier.wait(timeout=_LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS)
        assert "SPARK_TESTING" not in os.environ
        reports.put(("stopped", owner, None))
    except BaseException as error:
        reports.put(("error", owner, f"{type(error).__name__}: {error}"))
        raise
    finally:
        if had_spark_testing:
            assert previous_spark_testing is not None
            os.environ["SPARK_TESTING"] = previous_spark_testing
        else:
            os.environ.pop("SPARK_TESTING", None)


def _collect_local_connect_owner_reports(
    reports: Any,
    *,
    expected_event: str,
    owners: set[str],
) -> None:
    pending = set(owners)
    deadline = time.monotonic() + _LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS
    while pending:
        try:
            event, owner, detail = reports.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty as error:
            raise AssertionError(f"timed out waiting for {expected_event} reports from {sorted(pending)}") from error
        if event == "error":
            raise AssertionError(f"local Connect owner {owner} failed: {detail}")
        assert event == expected_event
        assert owner in pending
        assert detail is None
        pending.remove(owner)


def assert_parallel_local_connect_owners() -> None:
    process_context = multiprocessing.get_context("spawn")
    owners = {"first", "second"}
    startup_barrier = process_context.Barrier(len(owners) + 1)
    owners_live_barrier = process_context.Barrier(len(owners) + 1)
    reports = process_context.Queue()
    processes = [
        process_context.Process(
            target=_run_local_connect_owner,
            args=(owner, startup_barrier, owners_live_barrier, reports),
            name=f"open-wrangler-local-connect-{owner}",
        )
        for owner in sorted(owners)
    ]
    started_processes: list[Any] = []

    try:
        for process in processes:
            process.start()
            started_processes.append(process)
        startup_barrier.wait(timeout=_LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS)
        _collect_local_connect_owner_reports(reports, expected_event="ready", owners=owners)
        owners_live_barrier.wait(timeout=_LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS)
        _collect_local_connect_owner_reports(reports, expected_event="stopped", owners=owners)

        deadline = time.monotonic() + _LOCAL_CONNECT_OWNER_TIMEOUT_SECONDS
        for process in processes:
            process.join(timeout=max(0.0, deadline - time.monotonic()))
        assert all(not process.is_alive() for process in processes)
        assert {process.exitcode for process in processes} == {0}
    finally:
        startup_barrier.abort()
        owners_live_barrier.abort()
        for process in started_processes:
            if process.is_alive():
                process.terminate()
            process.join(timeout=5)
        reports.close()
        reports.join_thread()
