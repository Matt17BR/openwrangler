from __future__ import annotations

import os
import signal

import pytest
from python.tests.pyspark_connect_test_support import (
    FakeConnectFrame,
    FakeSparkConnectError,
    assert_parallel_local_connect_owners,
    scoped_spark_testing,
)

import openwrangler_runtime.engines.pyspark_engine as pyspark_engine_module
from openwrangler_runtime.engines import PySparkEngine


def test_spark_testing_scope_restores_existing_value(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SPARK_TESTING", "existing-value")
    with scoped_spark_testing():
        assert os.environ.get("SPARK_TESTING") == "1"
    assert os.environ.get("SPARK_TESTING") == "existing-value"


def test_parallel_local_connect_owners_use_independent_os_bound_ports() -> None:
    pyspark = pytest.importorskip("pyspark")
    assert pyspark.__version__.startswith("4.2.")
    assert_parallel_local_connect_owners()


def test_connect_request_scope_keeps_only_local_request_identity() -> None:
    engine = PySparkEngine()
    frame = FakeConnectFrame()
    engine._indexed_frame = frame
    previous_sigint = signal.getsignal(signal.SIGINT)

    with engine.request_scope("connect-request"):
        assert pyspark_engine_module._current_pyspark_request_id() == "connect-request"
        assert vars(frame.sparkSession) == {}
        assert signal.getsignal(signal.SIGINT) is previous_sigint

    assert pyspark_engine_module._current_pyspark_request_id() is None
    assert vars(frame.sparkSession) == {}
    assert signal.getsignal(signal.SIGINT) is previous_sigint


@pytest.mark.parametrize(
    "condition",
    (
        "NO_ACTIVE_SESSION",
        "INVALID_HANDLE.SESSION_CHANGED",
        "INVALID_HANDLE.SESSION_CLOSED",
        "INVALID_HANDLE.SESSION_NOT_FOUND",
        "CONNECT_INVALID_PLAN.DATAFRAME_NOT_FOUND",
    ),
)
def test_connect_request_failure_classifies_lost_server_state(condition: str) -> None:
    engine = PySparkEngine()
    engine._indexed_frame = FakeConnectFrame()

    assert engine.classify_request_failure(FakeSparkConnectError(condition=condition)) == "state_lost"


def test_connect_request_failure_classifies_reattach_session_loss() -> None:
    engine = PySparkEngine()
    engine._indexed_frame = FakeConnectFrame()

    error = FakeSparkConnectError(
        condition="RESPONSE_ALREADY_RECEIVED",
        parameters={"error_type": "INVALID_HANDLE.SESSION_NOT_FOUND"},
    )
    assert engine.classify_request_failure(error) == "state_lost"


def test_connect_request_failure_classifies_exhausted_unavailable_status() -> None:
    engine = PySparkEngine()
    engine._indexed_frame = FakeConnectFrame()

    assert (
        engine.classify_request_failure(FakeSparkConnectError(status_name="UNAVAILABLE")) == "temporarily_unavailable"
    )


def test_connect_request_failure_does_not_guess_from_messages_or_unrelated_conditions() -> None:
    engine = PySparkEngine()
    engine._indexed_frame = FakeConnectFrame()

    assert engine.classify_request_failure(RuntimeError("INVALID_HANDLE.SESSION_NOT_FOUND")) is None
    assert (
        engine.classify_request_failure(FakeSparkConnectError(condition="INVALID_HANDLE.OPERATION_NOT_FOUND")) is None
    )
    assert (
        engine.classify_request_failure(
            FakeSparkConnectError(
                condition="RESPONSE_ALREADY_RECEIVED",
                parameters={"error_type": "INVALID_HANDLE.OPERATION_NOT_FOUND"},
            )
        )
        is None
    )


def test_connect_stopped_probe_uses_the_session_local_flag() -> None:
    class ConnectSession:
        def __init__(self, stopped: bool) -> None:
            self.is_stopped = stopped

    class Frame:
        def __init__(self, stopped: bool) -> None:
            self.sparkSession = ConnectSession(stopped)

    assert PySparkEngine.live_source_is_stopped(Frame(False)) is False
    assert PySparkEngine.live_source_is_stopped(Frame(True)) is True
