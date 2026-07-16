from __future__ import annotations

import pytest

from openwrangler_runtime import SessionManager, __version__
from openwrangler_runtime.protocol import ProtocolError, decode_envelope


def test_initialize_advertises_the_canonical_runtime_version() -> None:
    assert SessionManager().initialize()["runtimeVersion"] == __version__


def test_protocol_v2_decodes_correlated_request() -> None:
    request_id, priority, request = decode_envelope(
        {
            "protocolVersion": 2,
            "requestId": "request-1",
            "priority": "interactive",
            "request": {"kind": "initialize"},
        }
    )

    assert request_id == "request-1"
    assert priority == "interactive"
    assert request == {"kind": "initialize"}


def test_open_session_accepts_only_a_non_empty_requested_session_identity() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "open-1",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "/tmp/sample.csv"},
            "requestedSessionId": "candidate-session",
            "pageSize": 200,
        },
    }

    assert decode_envelope(envelope)[2]["requestedSessionId"] == "candidate-session"
    envelope["request"]["requestedSessionId"] = ""
    with pytest.raises(ProtocolError, match="requestedSessionId must be a non-empty string"):
        decode_envelope(envelope)


@pytest.mark.parametrize("kind", ["getPage", "getSummary", "getDatasetStats", "getColumnValues"])
def test_view_queries_require_non_empty_view_request_ids(kind: str) -> None:
    request: dict[str, object] = {
        "kind": kind,
        "sessionId": "session-1",
        "revision": 0,
        "viewRequestId": "view-17",
        "filterModel": {"logic": "and", "filters": [], "sort": []},
    }
    if kind == "getPage":
        request.update(offset=0, limit=200)
    elif kind == "getColumnValues":
        request.update(column="city", limit=100)

    envelope = {
        "protocolVersion": 2,
        "requestId": "transport-1",
        "priority": "background" if kind != "getPage" else "interactive",
        "request": request,
    }
    assert decode_envelope(envelope)[2]["viewRequestId"] == "view-17"

    request.pop("viewRequestId")
    with pytest.raises(ProtocolError, match="viewRequestId"):
        decode_envelope(envelope)

    request["viewRequestId"] = ""
    with pytest.raises(ProtocolError, match="non-empty"):
        decode_envelope(envelope)


def test_protocol_v2_validates_transformation_steps() -> None:
    _, _, request = decode_envelope(
        {
            "protocolVersion": 2,
            "requestId": "preview-1",
            "priority": "interactive",
            "request": {
                "kind": "previewStep",
                "sessionId": "session-1",
                "revision": 0,
                "step": {
                    "id": "rename-1",
                    "kind": "renameColumn",
                    "params": {"column": "old", "newName": "new"},
                },
                "offset": 0,
                "limit": 200,
            },
        }
    )

    assert request["step"]["kind"] == "renameColumn"


def test_protocol_v2_rejects_malformed_transformation_steps() -> None:
    with pytest.raises(ProtocolError, match="missing required"):
        decode_envelope(
            {
                "protocolVersion": 2,
                "requestId": "preview-bad",
                "priority": "interactive",
                "request": {
                    "kind": "previewStep",
                    "sessionId": "session-1",
                    "revision": 0,
                    "step": {"id": "rename-1", "kind": "renameColumn", "params": {"column": "old"}},
                    "offset": 0,
                    "limit": 200,
                },
            }
        )


def test_protocol_v2_validates_export_format() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "export-1",
        "priority": "interactive",
        "request": {
            "kind": "exportData",
            "sessionId": "session-1",
            "revision": 2,
            "path": "/tmp/cleaned.csv",
            "format": "csv",
        },
    }
    assert decode_envelope(envelope)[2]["format"] == "csv"
    envelope["request"]["format"] = "xlsx"
    with pytest.raises(ProtocolError, match="csv or parquet"):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    "envelope",
    [
        {"protocolVersion": 1, "requestId": "x", "priority": "interactive", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "", "priority": "interactive", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "x", "priority": "fast", "request": {"kind": "initialize"}},
        {"protocolVersion": 2, "requestId": "x", "priority": "interactive", "request": {"kind": "getPage"}},
    ],
)
def test_protocol_v2_rejects_malformed_envelopes(envelope: object) -> None:
    with pytest.raises(ProtocolError):
        decode_envelope(envelope)
