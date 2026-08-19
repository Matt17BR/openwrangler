from __future__ import annotations

import json
from concurrent.futures import CancelledError
from typing import Any

import pandas as pd
import pytest

from openwrangler_runtime import kernel_agent, notebook
from openwrangler_runtime.engines import AmbiguousViewColumnError
from openwrangler_runtime.session import (
    LiveSourceInvalidatedError,
    PySparkConnectStateLostError,
    PySparkConnectUnavailableError,
    ResponsePayloadError,
    SessionCleanupError,
    SessionManager,
)

EMPTY_FILTER = {"filters": [], "sort": []}


def _envelope(request: dict[str, Any], *, request_id: str = "kernel-request") -> str:
    return json.dumps(
        {
            "protocolVersion": 2,
            "requestId": request_id,
            "priority": "interactive",
            "request": request,
        }
    )


def test_kernel_agent_opens_an_opaque_live_result_handle(monkeypatch) -> None:
    manager = SessionManager()
    monkeypatch.setattr(kernel_agent, "_manager", manager)
    frame = pd.DataFrame({"value": [7]}).head(1)
    handle = notebook._register_live_result(frame)

    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "openSession",
                    "source": {"kind": "notebookVariable", "label": "DataFrame", "variableName": handle},
                    "backend": "pandas",
                    "pageSize": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
                request_id="temporary-result-request",
            )
        )
    )

    assert result["requestId"] == "temporary-result-request"
    assert result["response"]["kind"] == "sessionOpened"
    assert result["response"]["metadata"]["source"]["variableName"] == handle
    assert result["response"]["page"]["rows"][0]["values"][0]["display"] == "7"
    manager.close_session(
        result["response"]["metadata"]["sessionId"],
        result["response"]["metadata"]["revision"],
    )


def test_unknown_session_error_is_a_correlated_protocol_response(monkeypatch) -> None:
    monkeypatch.setattr(kernel_agent, "_manager", SessionManager())

    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "missing-session",
                    "revision": 0,
                    "viewRequestId": "view-unknown-session",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="unknown-session-request",
            )
        )
    )

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "unknown-session-request"
    assert result["response"] == {
        "kind": "error",
        "code": "unknown_session",
        "message": "Unknown session: missing-session",
        "recoverable": True,
        "sessionId": "missing-session",
        "viewRequestId": "view-unknown-session",
    }


def test_unknown_session_close_preserves_the_exact_candidate_identity(monkeypatch) -> None:
    monkeypatch.setattr(kernel_agent, "_manager", SessionManager())

    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "closeSession",
                    "sessionId": "missing-close-candidate",
                    "revision": 0,
                },
                request_id="missing-close-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "missing-close-request",
        "response": {
            "kind": "error",
            "code": "unknown_session",
            "message": "Unknown session: missing-close-candidate",
            "recoverable": True,
            "sessionId": "missing-close-candidate",
        },
    }


def test_live_source_invalidation_is_a_correlated_recoverable_response(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], request_id: str) -> dict[str, Any]:
        assert request_id == "live-source-request"
        raise LiveSourceInvalidatedError("spark-session", "The live PySpark dataframe was replaced.")

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "spark-session",
                    "revision": 0,
                    "viewRequestId": "view-live-source",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="live-source-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "live-source-request",
        "response": {
            "kind": "error",
            "code": "live_source_invalidated",
            "message": "The live PySpark dataframe was replaced.",
            "recoverable": True,
            "sessionId": "spark-session",
            "viewRequestId": "view-live-source",
        },
    }


@pytest.mark.parametrize(
    ("error", "code"),
    (
        (
            PySparkConnectUnavailableError("spark-session", "Spark Connect is temporarily unavailable."),
            "pyspark_connect_unavailable",
        ),
        (
            PySparkConnectStateLostError("spark-session", "The Spark Connect dataframe no longer exists."),
            "pyspark_connect_state_lost",
        ),
    ),
    ids=("temporarily-unavailable", "state-lost"),
)
def test_spark_connect_failure_is_a_correlated_recoverable_response(
    monkeypatch: pytest.MonkeyPatch,
    error: Exception,
    code: str,
) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], request_id: str) -> dict[str, Any]:
        assert request_id == "spark-connect-request"
        raise error

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "spark-session",
                    "revision": 0,
                    "viewRequestId": "view-spark-connect",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="spark-connect-request",
            )
        )
    )

    assert result["response"] == {
        "kind": "error",
        "code": code,
        "message": str(error),
        "recoverable": True,
        "sessionId": "spark-session",
        "viewRequestId": "view-spark-connect",
    }


def test_terminal_cleanup_failure_preserves_the_exact_candidate_identity(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], _request_id: str) -> dict[str, Any]:
        raise SessionCleanupError("cleanup-session", "Could not release the Spark cache.")

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {"kind": "closeSession", "sessionId": "cleanup-session", "revision": 0},
                request_id="cleanup-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "cleanup-request",
        "response": {
            "kind": "error",
            "code": "session_cleanup_failed",
            "message": "Could not release the Spark cache.",
            "recoverable": False,
            "sessionId": "cleanup-session",
        },
    }


def test_mutation_response_preflight_failure_preserves_its_structured_code(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], _request_id: str) -> dict[str, Any]:
        raise ResponsePayloadError(
            "The correlated mutation response is not valid strict JSON.",
            "response_encoding_failed",
        )

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "previewStep",
                    "sessionId": "session",
                    "revision": 0,
                    "step": {
                        "id": "preview",
                        "kind": "dropColumns",
                        "params": {"columns": [{"id": "c:source:0", "name": "value"}]},
                    },
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
                request_id="mutation-preflight-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "mutation-preflight-request",
        "response": {
            "kind": "error",
            "code": "response_encoding_failed",
            "message": "The correlated mutation response is not valid strict JSON.",
            "recoverable": True,
        },
    }


def test_decoder_error_preserves_available_request_and_view_correlation() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-malformed",
                    "offset": 0,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="malformed-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "malformed-request",
        "response": {
            "kind": "error",
            "code": "invalid_request",
            "message": "getPage request is missing required fields: limit",
            "recoverable": False,
            "viewRequestId": "view-malformed",
        },
    }


def test_malformed_json_still_returns_a_canonical_envelope() -> None:
    result = json.loads(kernel_agent.dispatch_json("not-json"))

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "unknown"
    assert result["response"]["kind"] == "error"
    assert result["response"]["code"] == "runtime_error"


def test_malformed_envelope_preserves_its_available_request_id() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            json.dumps(
                {
                    "protocolVersion": 2,
                    "requestId": "malformed-envelope",
                    "request": {"kind": "initialize"},
                }
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "malformed-envelope",
        "response": {
            "kind": "error",
            "code": "invalid_request",
            "message": "priority must be interactive or background.",
            "recoverable": False,
        },
    }


def test_cancelled_dispatch_is_returned_as_a_correlated_response(monkeypatch) -> None:
    def cancel(_manager: SessionManager, _request: dict[str, Any], _request_id: str) -> dict[str, Any]:
        raise CancelledError

    monkeypatch.setattr(kernel_agent, "dispatch", cancel)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-cancelled",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="cancelled-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "cancelled-request",
        "response": {
            "kind": "cancelled",
            "targetRequestId": "cancelled-request",
            "viewRequestId": "view-cancelled",
        },
    }


def test_unexpected_dispatch_error_is_returned_as_a_correlated_response(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], _request_id: str) -> dict[str, Any]:
        raise RuntimeError("unexpected failure")

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-error",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="error-request",
            )
        )
    )

    assert result["protocolVersion"] == 2
    assert result["requestId"] == "error-request"
    assert result["response"]["kind"] == "error"
    assert result["response"]["code"] == "runtime_error"
    assert result["response"]["message"] == "unexpected failure"
    assert result["response"]["viewRequestId"] == "view-error"


def test_ambiguous_view_column_is_returned_as_a_correlated_structured_diagnostic(monkeypatch) -> None:
    def fail(_manager: SessionManager, _request: dict[str, Any], _request_id: str) -> dict[str, Any]:
        raise AmbiguousViewColumnError("two Pandas columns share the displayed name '7'")

    monkeypatch.setattr(kernel_agent, "dispatch", fail)
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": "session",
                    "revision": 0,
                    "viewRequestId": "view-ambiguous",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="ambiguous-request",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "ambiguous-request",
        "response": {
            "kind": "error",
            "code": "ambiguous_view_column",
            "message": "two Pandas columns share the displayed name '7'",
            "recoverable": True,
            "viewRequestId": "view-ambiguous",
        },
    }


def test_cancel_request_returns_a_protocol_acknowledgement() -> None:
    result = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {"kind": "cancelRequest", "targetRequestId": "target-request"},
                request_id="cancel-command",
            )
        )
    )

    assert result == {
        "protocolVersion": 2,
        "requestId": "cancel-command",
        "response": {"kind": "cancelled", "targetRequestId": "target-request"},
    }
