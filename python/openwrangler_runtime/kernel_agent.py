from __future__ import annotations

import json
import traceback
from collections.abc import Mapping
from concurrent.futures import CancelledError

from .engines import EngineError
from .protocol import ProtocolError, decode_envelope, error_response, response_envelope
from .server import dispatch
from .session import SessionManager

_manager = SessionManager()


def dispatch_json(payload: str) -> str:
    """Dispatch an Open Wrangler request inside the active Jupyter kernel."""
    request_id = _safe_request_id(payload)
    view_request_id = _safe_view_request_id(payload)
    try:
        request_id, _, request = decode_envelope(json.loads(payload))
        view_request_id = request.get("viewRequestId")
        if request["kind"] == "cancelRequest":
            response = {"kind": "cancelled", "targetRequestId": request["targetRequestId"]}
        else:
            response = dispatch(_manager, request)
        return _encode_response(request_id, response)
    except CancelledError:
        response = {"kind": "cancelled", "targetRequestId": request_id}
    except ProtocolError as error:
        response = error_response(str(error), code="invalid_request", recoverable=False)
    except EngineError as error:
        response = error_response(str(error), code="engine_error")
    except Exception as error:
        response = error_response(str(error), detail=traceback.format_exc())
    if view_request_id:
        response["viewRequestId"] = view_request_id
    return _encode_response(request_id, response)


def _encode_response(request_id: str, response: Mapping[str, object]) -> str:
    return json.dumps(response_envelope(request_id, response), default=str, allow_nan=False)


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
