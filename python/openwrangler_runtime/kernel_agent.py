from __future__ import annotations

import json
import traceback
from collections.abc import Mapping
from concurrent.futures import CancelledError

from .engines import AmbiguousViewColumnError, EngineError
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .response_framing import (
    MAX_RESPONSE_FRAME_BYTES,
    ResponseEncodingError,
    ResponseFrameTooLargeError,
    encode_response_frame,
)
from .server import dispatch
from .session import (
    LiveSourceInvalidatedError,
    PySparkConnectStateLostError,
    PySparkConnectUnavailableError,
    ResponsePayloadError,
    SessionCleanupError,
    SessionManager,
    UnknownSessionError,
)

_RECOVERABLE_RESPONSE_ENCODING_KINDS = {
    "initialize",
    "getPage",
    "getSummary",
    "getDatasetStats",
    "getColumnValues",
    "inspectStep",
    "cancelRequest",
}

_manager = SessionManager()


def dispatch_json(payload: str) -> str:
    """Dispatch an Open Wrangler request inside the active Jupyter kernel."""
    request_id = _safe_request_id(payload)
    request_kind: str | None = None
    view_request_id = _safe_view_request_id(payload)
    try:
        request_id, _, request = decode_envelope(json.loads(payload))
        request_kind = request["kind"]
        view_request_id = request.get("viewRequestId")
        if request_kind == "cancelRequest":
            response = {"kind": "cancelled", "targetRequestId": request["targetRequestId"]}
        else:
            response = dispatch(_manager, request, request_id)
        return _encode_response(request_id, response)
    except CancelledError:
        response = {"kind": "cancelled", "targetRequestId": request_id}
    except ProtocolError as error:
        response = error_response(str(error), code="invalid_request", recoverable=False)
    except UnknownSessionError as error:
        response = error_response(str(error), code="unknown_session", session_id=error.session_id)
    except LiveSourceInvalidatedError as error:
        response = error_response(str(error), code="live_source_invalidated", session_id=error.session_id)
    except PySparkConnectUnavailableError as error:
        response = error_response(str(error), code="pyspark_connect_unavailable", session_id=error.session_id)
    except PySparkConnectStateLostError as error:
        response = error_response(str(error), code="pyspark_connect_state_lost", session_id=error.session_id)
    except SessionCleanupError as error:
        response = error_response(
            str(error),
            code="session_cleanup_failed",
            recoverable=False,
            session_id=error.session_id,
        )
    except ResponsePayloadError as error:
        response = error_response(str(error), code=error.code)
    except ResponseFrameTooLargeError:
        if request_kind not in _RECOVERABLE_RESPONSE_ENCODING_KINDS:
            raise
        response = error_response(
            "The runtime response exceeds the bounded transport frame limit.",
            code="response_too_large",
        )
    except ResponseEncodingError:
        if request_kind not in _RECOVERABLE_RESPONSE_ENCODING_KINDS:
            raise
        response = error_response(
            "The runtime response could not be encoded as strict JSON.",
            code="response_encoding_failed",
        )
    except AmbiguousViewColumnError as error:
        response = error_response(str(error), code="ambiguous_view_column")
    except EngineError as error:
        response = error_response(str(error), code="engine_error")
    except Exception as error:
        response = error_response(str(error), detail=traceback.format_exc())
    if view_request_id:
        response["viewRequestId"] = view_request_id
    return _encode_response(request_id, response)


def _encode_response(request_id: str, response: Mapping[str, object]) -> str:
    frame = encode_response_frame(
        response_envelope(request_id, response),
        MAX_RESPONSE_FRAME_BYTES,
    )
    return frame[:-1].decode("utf-8")


def _safe_request_id(payload: str) -> str:
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict):
            return str(decoded.get("requestId", "unknown"))
    except Exception:
        pass
    return "unknown"


def _safe_view_request_id(payload: str) -> str | None:
    try:
        decoded = json.loads(payload)
        if isinstance(decoded, dict) and isinstance(decoded.get("request"), dict):
            view_request_id = decoded["request"].get("viewRequestId")
            return view_request_id if isinstance(view_request_id, str) and view_request_id else None
    except Exception:
        pass
    return None
