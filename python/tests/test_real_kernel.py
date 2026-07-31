from __future__ import annotations

import base64
import json
from collections.abc import Mapping
from queue import Empty
from time import monotonic
from typing import Any

import pytest
from jupyter_client.manager import KernelManager


@pytest.fixture
def live_kernel():
    manager = KernelManager()
    manager.start_kernel(extra_arguments=["--HistoryManager.hist_file=:memory:"])
    client = manager.blocking_client()
    client.start_channels()
    client.wait_for_ready(timeout=60)
    try:
        yield manager, client
    finally:
        client.stop_channels()
        manager.shutdown_kernel(now=True)


def test_real_kernel_transport_handles_both_engines_and_restart(live_kernel) -> None:
    manager, client = live_kernel
    bootstrap = """
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
import openwrangler_runtime.notebook as __ow_notebook
__ow_notebook.register_formatters()
"""
    _execute(client, bootstrap)

    initialized = _dispatch(client, "initialize", {"kind": "initialize"})
    assert initialized["response"]["kind"] == "initialized"
    assert initialized["response"]["protocolVersion"] == 2

    missing = _dispatch(
        client,
        "missing-session",
        {
            "kind": "getPage",
            "sessionId": "missing",
            "revision": 0,
            "viewRequestId": "view-missing",
            "offset": 0,
            "limit": 10,
            "columnOffset": 0,
            "columnLimit": 64,
            "filterModel": {"filters": [], "sort": []},
        },
    )
    assert missing["protocolVersion"] == 2
    assert missing["requestId"] == "missing-session"
    assert missing["response"]["kind"] == "error"
    assert missing["response"]["code"] == "unknown_session"
    assert missing["response"]["sessionId"] == "missing"
    assert missing["response"]["viewRequestId"] == "view-missing"

    missing_close = _dispatch(
        client,
        "missing-close",
        {
            "kind": "closeSession",
            "sessionId": "missing-close-candidate",
            "revision": 0,
        },
    )
    assert missing_close["response"] == {
        "kind": "error",
        "code": "unknown_session",
        "message": "Unknown session: missing-close-candidate",
        "recoverable": True,
        "sessionId": "missing-close-candidate",
    }

    malformed = _dispatch(
        client,
        "malformed-page",
        {
            "kind": "getPage",
            "sessionId": "missing",
            "revision": 0,
            "viewRequestId": "view-malformed",
            "offset": 0,
            "columnOffset": 0,
            "columnLimit": 64,
            "filterModel": {"filters": [], "sort": []},
        },
    )
    assert malformed["protocolVersion"] == 2
    assert malformed["requestId"] == "malformed-page"
    assert malformed["response"]["kind"] == "error"
    assert malformed["response"]["code"] == "invalid_request"
    assert malformed["response"]["viewRequestId"] == "view-malformed"

    _execute(
        client,
        "import pandas as pd\nimport polars as pl\npandas_frame = pd.DataFrame({'value': [1, 2]})\n"
        "polars_frame = pl.DataFrame({'value': [3, 4]})",
    )
    _, pandas_mime = _execute_with_data(client, "pandas_frame")
    _, polars_mime = _execute_with_data(client, "polars_frame")
    mime_type = "application/vnd.openwrangler.viewer.v2+json"
    assert pandas_mime[mime_type]["metadata"]["backend"] == "pandas"
    assert polars_mime[mime_type]["metadata"]["backend"] == "polars"
    assert "text/plain" in pandas_mime
    assert "text/plain" in polars_mime
    assert "text/html" not in pandas_mime
    assert "text/html" not in polars_mime
    pandas_opened = _dispatch(
        client,
        "pandas",
        {
            "kind": "openSession",
            "source": {"kind": "notebookVariable", "label": "pandas_frame", "variableName": "pandas_frame"},
            "backend": "pandas",
            "mode": "viewing",
            "pageSize": 10,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    )
    polars_opened = _dispatch(
        client,
        "polars",
        {
            "kind": "openSession",
            "source": {"kind": "notebookVariable", "label": "polars_frame", "variableName": "polars_frame"},
            "backend": "polars",
            "mode": "viewing",
            "pageSize": 10,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    )
    assert pandas_opened["response"]["metadata"]["backend"] == "pandas"
    assert polars_opened["response"]["metadata"]["backend"] == "polars"
    assert pandas_opened["response"]["page"]["rows"][1]["values"][0]["display"] == "2"
    assert polars_opened["response"]["page"]["rows"][0]["values"][0]["display"] == "3"

    manager.restart_kernel(now=True)
    client.wait_for_ready(timeout=60)
    _execute(client, bootstrap)
    restarted = _dispatch(client, "restarted", {"kind": "initialize"})
    assert restarted["response"]["kind"] == "initialized"


def test_execute_helper_drains_shell_reply_after_kernel_error(live_kernel) -> None:
    _, client = live_kernel

    with pytest.raises(pytest.fail.Exception, match="ZeroDivisionError"):
        _execute(client, "1 / 0")

    # A failed execution has the same two-channel completion contract as a
    # successful one. Its correlated execute_reply must not remain queued.
    with pytest.raises(Empty):
        client.get_shell_msg(timeout=0.1)

    assert _execute(client, "print('kernel-still-responsive')") == "kernel-still-responsive\n"


def _dispatch(client: Any, request_id: str, request: Mapping[str, Any]) -> dict[str, Any]:
    envelope = {
        "protocolVersion": 2,
        "requestId": request_id,
        "priority": "interactive",
        "request": request,
    }
    payload = base64.b64encode(json.dumps(envelope).encode()).decode()
    marker = request_id.replace("-", "")
    output = _execute(
        client,
        f"""
import base64 as __ow_base64
import openwrangler_runtime.kernel_agent as __ow_kernel_agent
__ow_payload = __ow_base64.b64decode({payload!r}).decode("utf-8")
print("__OPEN_WRANGLER_START_{marker}__")
print(__ow_kernel_agent.dispatch_json(__ow_payload))
print("__OPEN_WRANGLER_END_{marker}__")
""",
    )
    start = f"__OPEN_WRANGLER_START_{marker}__"
    end = f"__OPEN_WRANGLER_END_{marker}__"
    return json.loads(output.split(start, 1)[1].split(end, 1)[0].strip())


def _execute(client: Any, code: str) -> str:
    return _execute_with_data(client, code)[0]


def _execute_with_data(client: Any, code: str) -> tuple[str, dict[str, Any]]:
    message_id = client.execute(code)
    chunks: list[str] = []
    data: dict[str, Any] = {}
    execution_error: Mapping[str, Any] | None = None
    deadline = monotonic() + 60
    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            pytest.fail(f"Kernel execution {message_id} did not become idle within 60 seconds")
        try:
            message = client.get_iopub_msg(timeout=min(5, remaining))
        except Empty:
            continue
        if message.get("parent_header", {}).get("msg_id") != message_id:
            continue
        message_type = message.get("msg_type")
        content = message.get("content", {})
        if message_type == "stream":
            chunks.append(str(content.get("text", "")))
        elif message_type in {"display_data", "execute_result"}:
            data.update(content.get("data", {}))
        elif message_type == "error":
            execution_error = content
        elif message_type == "status" and content.get("execution_state") == "idle":
            break

    # An execution is complete only after both its IOPub idle notification and
    # correlated shell reply arrive. Leaving execute_reply messages unread can
    # eventually apply shell-channel backpressure and make an unrelated later
    # request appear to hang, especially on Python 3.14/pyzmq.
    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            pytest.fail(f"Kernel execution {message_id} did not return its shell reply within 60 seconds")
        try:
            reply = client.get_shell_msg(timeout=min(5, remaining))
        except Empty:
            continue
        if reply.get("parent_header", {}).get("msg_id") != message_id:
            continue
        if reply.get("msg_type") != "execute_reply":
            pytest.fail(
                f"Kernel execution {message_id} returned correlated shell message "
                f"{reply.get('msg_type')!r} instead of 'execute_reply'"
            )
        content = reply.get("content", {})
        if execution_error is not None:
            traceback = execution_error.get("traceback", [])
            if isinstance(traceback, list) and all(isinstance(line, str) for line in traceback):
                pytest.fail("\n".join(traceback))
            pytest.fail(
                f"Kernel execution {message_id} failed with "
                f"{execution_error.get('ename')!r}: {execution_error.get('evalue')!r}"
            )
        if content.get("status") != "ok":
            pytest.fail(
                f"Kernel execution {message_id} returned shell status {content.get('status')!r}: "
                f"{content.get('ename')!r}: {content.get('evalue')!r}"
            )
        return "".join(chunks), data
