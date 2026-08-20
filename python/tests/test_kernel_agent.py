from __future__ import annotations

import json
from concurrent.futures import CancelledError
from typing import Any

import pandas as pd
import pytest

from openwrangler_runtime import kernel_agent, notebook, server
from openwrangler_runtime import session as session_runtime
from openwrangler_runtime.engines import AmbiguousViewColumnError, EngineError
from openwrangler_runtime.protocol import response_envelope
from openwrangler_runtime.response_framing import MAX_RESPONSE_FRAME_BYTES, encode_response_frame
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


def test_standalone_and_kernel_dispatch_share_generated_code_preflight(tmp_path, monkeypatch) -> None:
    path = tmp_path / "shared-preflight.csv"
    path.write_text("value\n1\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend="pandas",
        mode="editing",
        page_size=20,
    )
    session_id = opened["metadata"]["sessionId"]
    request = {
        "kind": "previewStep",
        "sessionId": session_id,
        "revision": 0,
        "step": {
            "id": "shared-code-preflight",
            "kind": "customCode",
            "params": {"code": "result = df"},
        },
        "offset": 0,
        "limit": 20,
        "columnOffset": 0,
        "columnLimit": 64,
    }
    monkeypatch.setattr(session_runtime, "MAX_GENERATED_PYTHON_CODE_UTF8_BYTES", 256)

    with pytest.raises(EngineError, match=r"256 UTF-8 bytes"):
        server.dispatch(manager, request, "standalone-code-preflight")
    assert manager.sessions[session_id].revision == 0
    assert manager.sessions[session_id].draft_step is None

    monkeypatch.setattr(kernel_agent, "_manager", manager)
    kernel_response = json.loads(kernel_agent.dispatch_json(_envelope(request, request_id="kernel-code-preflight")))[
        "response"
    ]
    assert kernel_response == {
        "kind": "error",
        "code": "engine_error",
        "message": "Generated Python code may contain at most 256 UTF-8 bytes.",
        "recoverable": True,
    }
    assert manager.sessions[session_id].revision == 0
    assert manager.sessions[session_id].draft_step is None
    manager.close_session(session_id, 0)


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


def test_kernel_response_uses_the_bounded_compact_utf8_frame_encoder() -> None:
    value = "é" * 30_000
    cell = {"kind": "string", "raw": value, "display": value, "isNull": False, "isNaN": False}
    response = {
        "kind": "stepPreview",
        "revision": 1,
        "page": {
            "offset": 0,
            "limit": 100,
            "totalRows": 100,
            "columnIds": ["c:source:0"],
            "rows": [{"rowId": str(index), "values": [cell]} for index in range(100)],
        },
    }
    envelope = response_envelope("non-ascii-response", response)

    encoded = kernel_agent._encode_response("non-ascii-response", response)

    assert encoded.encode("utf-8") == encode_response_frame(envelope, MAX_RESPONSE_FRAME_BYTES)[:-1]
    assert len(encoded.encode("utf-8")) + 1 <= MAX_RESPONSE_FRAME_BYTES
    assert "é" in encoded
    assert "\\u00e9" not in encoded
    assert len(json.dumps(envelope).encode("utf-8")) > MAX_RESPONSE_FRAME_BYTES


def test_kernel_dispatches_a_non_ascii_mutation_with_the_preflighted_encoding(monkeypatch) -> None:
    manager = SessionManager()
    monkeypatch.setattr(kernel_agent, "_manager", manager)
    value = "é" * 15_000
    frame = pd.DataFrame({"city": [value] * 100})
    handle = notebook._register_live_result(frame)
    opened = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "openSession",
                    "source": {"kind": "notebookVariable", "label": "DataFrame", "variableName": handle},
                    "backend": "pandas",
                    "mode": "editing",
                    "pageSize": 100,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
                request_id="open-non-ascii-session",
            )
        )
    )["response"]
    session_id = opened["metadata"]["sessionId"]

    encoded = kernel_agent.dispatch_json(
        _envelope(
            {
                "kind": "previewStep",
                "sessionId": session_id,
                "revision": 0,
                "step": {
                    "id": "rename-non-ascii",
                    "kind": "renameColumn",
                    "params": {
                        "column": {"id": "c:source:0", "name": "city"},
                        "newName": "place",
                    },
                },
                "offset": 0,
                "limit": 100,
                "columnOffset": 0,
                "columnLimit": 64,
            },
            request_id="preview-non-ascii",
        )
    )
    decoded = json.loads(encoded)

    assert decoded["response"]["kind"] == "stepPreview"
    assert decoded["response"]["revision"] == 1
    assert len(encoded.encode("utf-8")) + 1 <= MAX_RESPONSE_FRAME_BYTES
    assert "é" in encoded
    assert "\\u00e9" not in encoded
    assert len(json.dumps(decoded).encode("utf-8")) > MAX_RESPONSE_FRAME_BYTES
    manager.close_session(session_id, 1)


def test_kernel_mutation_preflight_failure_rolls_back_real_dispatch(monkeypatch) -> None:
    manager = SessionManager()
    monkeypatch.setattr(kernel_agent, "_manager", manager)
    frame = pd.DataFrame({"name": ["a", "b"], "value": [1, 2]})
    handle = notebook._register_live_result(frame)
    opened = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "openSession",
                    "source": {"kind": "notebookVariable", "label": "DataFrame", "variableName": handle},
                    "backend": "pandas",
                    "mode": "editing",
                    "pageSize": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
                request_id="open-rollback-session",
            )
        )
    )["response"]
    session_id = opened["metadata"]["sessionId"]
    original_page = opened["page"]
    monkeypatch.setattr(server, "MAX_RESPONSE_FRAME_BYTES", 256)

    failed = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "previewStep",
                    "sessionId": session_id,
                    "revision": 0,
                    "step": {
                        "id": "notebook-preflight-rollback",
                        "kind": "formula",
                        "params": {
                            "leftColumn": {"id": "c:source:1", "name": "value"},
                            "operator": "multiply",
                            "value": 2,
                            "newColumn": "doubled",
                        },
                    },
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
                request_id="notebook-preflight-rollback",
            )
        )
    )

    assert failed["response"]["kind"] == "error"
    assert failed["response"]["code"] == "response_too_large", failed
    session = manager.sessions[session_id]
    assert session.revision == 0
    assert session.plan == []
    assert session.bound_plan == []
    assert session.draft_step is None
    assert session.draft_frame is None

    observed = json.loads(
        kernel_agent.dispatch_json(
            _envelope(
                {
                    "kind": "getPage",
                    "sessionId": session_id,
                    "revision": 0,
                    "viewRequestId": "view-after-rollback",
                    "offset": 0,
                    "limit": 20,
                    "columnOffset": 0,
                    "columnLimit": 64,
                    "filterModel": EMPTY_FILTER,
                },
                request_id="get-after-rollback",
            )
        )
    )["response"]
    assert observed["kind"] == "page"
    assert observed["metadata"]["revision"] == 0
    assert observed["page"] == original_page
    manager.close_session(session_id, 0)


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
