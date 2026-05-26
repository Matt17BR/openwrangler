from __future__ import annotations

import json
import sys
import traceback
from typing import Any

from .engines import EngineError
from .session import SessionManager


def dispatch(manager: SessionManager, request: dict[str, Any]) -> dict[str, Any]:
    kind = request.get("kind")
    if kind == "openSession":
        return manager.open_session(request["source"], request.get("backend"), int(request.get("pageSize", 200)))
    if kind == "getPage":
        return manager.get_page(
            request["sessionId"],
            int(request.get("offset", 0)),
            int(request.get("limit", 200)),
            request.get("filterModel", {"filters": [], "sort": []}),
        )
    if kind == "getSummary":
        return manager.get_summary(
            request["sessionId"],
            request.get("filterModel", {"filters": [], "sort": []}),
            request.get("columns"),
        )
    if kind == "getColumnValues":
        return manager.get_column_values(
            request["sessionId"],
            request["column"],
            request.get("filterModel", {"filters": [], "sort": []}),
            request.get("search"),
            int(request.get("limit", 100)),
        )
    raise EngineError(f"Unsupported request kind: {kind}")


def main() -> None:
    manager = SessionManager()
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            envelope = json.loads(line)
            response = dispatch(manager, envelope["request"])
            write({"id": envelope["id"], "response": response})
        except Exception as error:
            write(
                {
                    "id": _safe_id(line),
                    "error": str(error),
                    "detail": traceback.format_exc(),
                }
            )


def write(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, default=str) + "\n")
    sys.stdout.flush()


def _safe_id(line: str) -> str:
    try:
        return str(json.loads(line).get("id", "unknown"))
    except Exception:
        return "unknown"


if __name__ == "__main__":
    main()
