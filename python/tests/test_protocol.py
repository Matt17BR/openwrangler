from __future__ import annotations

import pytest

from data_wrangler_runtime.protocol import ProtocolError, decode_envelope


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
