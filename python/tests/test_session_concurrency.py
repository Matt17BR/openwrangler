from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import deepcopy
from pathlib import Path
from typing import Any

import pytest

from openwrangler_runtime.engines import EngineError, EngineRegistry, PolarsEngine
from openwrangler_runtime.session import SessionManager
from openwrangler_runtime.session_access import SessionRequestAdmission

CONCURRENCY_COMPLETION_TIMEOUT_SECONDS = 5


def test_foreground_page_overtakes_active_profile_while_mutation_waits(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\nrome,2\n", encoding="utf-8")
    profile_started = threading.Event()
    release_profile = threading.Event()

    class BlockingProfileEngine(PolarsEngine):
        def summaries(self, frame: Any, column_projection: Any = None) -> list[dict[str, Any]]:
            profile_started.set()
            if not release_profile.wait(2):
                raise TimeoutError("The test profile was not released.")
            return super().summaries(frame, column_projection)

    manager = SessionManager(EngineRegistry((("polars", BlockingProfileEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}

    with ThreadPoolExecutor(max_workers=3) as executor:
        profile = executor.submit(manager.get_summary, session_id, 0, filter_model, ["c:source:1"])
        assert profile_started.wait(1)

        page = executor.submit(manager.get_page, session_id, 0, 1, 1, filter_model)
        assert page.result(timeout=0.5)["page"]["offset"] == 1

        preview = executor.submit(
            manager.preview_step,
            session_id,
            0,
            {
                "id": "drop-city",
                "kind": "dropColumns",
                "params": {"columns": [{"id": "c:source:0", "name": "city"}]},
            },
            0,
            1,
        )
        try:
            preview.result(timeout=0.05)
        except TimeoutError:
            pass
        else:
            raise AssertionError("A mutation ran concurrently with an active profile.")

        release_profile.set()
        assert profile.result(timeout=1)["summaries"][0]["column"] == "value"
        assert preview.result(timeout=1)["kind"] == "stepPreview"

    manager.close_all()


def test_profile_failure_revalidates_source_and_releases_lease(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\n", encoding="utf-8")

    class ReplacingProfileEngine(PolarsEngine):
        def summaries(self, frame: Any, column_projection: Any = None) -> list[dict[str, Any]]:
            replacement = source_path.with_suffix(".replacement")
            replacement.write_text("city,value\nrome,2\n", encoding="utf-8")
            replacement.replace(source_path)
            raise RuntimeError("profile scan failed after replacement")

    manager = SessionManager(EngineRegistry((("polars", ReplacingProfileEngine),)))
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]

    with pytest.raises(EngineError, match=r"changed or is no longer available.*Reopen") as raised:
        manager.get_summary(session_id, 0, {"filters": [], "sort": []}, ["c:source:1"])

    assert isinstance(raised.value.__cause__, RuntimeError)
    manager.close_all()


def test_request_admission_prefers_a_waiting_writer_over_late_reads_and_profiles() -> None:
    admission = SessionRequestAdmission()
    first_profile_started = threading.Event()
    release_first_profile = threading.Event()
    writer_entered = threading.Event()
    release_writer = threading.Event()
    late_read_entered = threading.Event()
    late_profile_captured = threading.Event()

    def first_profile() -> None:
        def capture_view() -> object:
            first_profile_started.set()
            return object()

        with admission.profile(capture_view, lambda: None):
            if not release_first_profile.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS):
                raise TimeoutError("The first profile was not released.")

    def writer() -> None:
        with admission.exclusive():
            writer_entered.set()
            if not release_writer.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS):
                raise TimeoutError("The writer was not released.")

    def late_read() -> None:
        with admission.shared():
            late_read_entered.set()

    def late_profile() -> None:
        def capture_view() -> object:
            late_profile_captured.set()
            return object()

        with admission.profile(capture_view, lambda: None):
            pass

    with ThreadPoolExecutor(max_workers=4) as executor:
        first_profile_future = executor.submit(first_profile)
        assert first_profile_started.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        writer_future = executor.submit(writer)
        for _ in range(100):
            if admission._waiting_writers:
                break
            threading.Event().wait(0.005)
        assert admission._waiting_writers == 1

        late_read_future = executor.submit(late_read)
        late_profile_future = executor.submit(late_profile)
        release_first_profile.set()
        assert writer_entered.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        assert not late_read_entered.wait(0.05)
        assert not late_profile_captured.wait(0.05)

        release_writer.set()
        first_profile_future.result(timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        writer_future.result(timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        late_read_future.result(timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        late_profile_future.result(timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        assert late_read_entered.is_set()
        assert late_profile_captured.is_set()


def test_request_admission_releases_profile_and_writer_intent_after_failure() -> None:
    admission = SessionRequestAdmission()

    def fail_revalidation() -> None:
        raise RuntimeError("profile revalidation failed")

    with (
        pytest.raises(RuntimeError, match="profile revalidation failed"),
        admission.profile(object, fail_revalidation),
    ):
        pass
    with admission.exclusive():
        pass

    with pytest.raises(RuntimeError, match="exclusive operation failed"), admission.exclusive():
        raise RuntimeError("exclusive operation failed")
    with admission.shared():
        pass


def test_response_metadata_is_detached_from_later_plan_mutations(tmp_path: Path) -> None:
    source_path = tmp_path / "values.csv"
    source_path.write_text("city,value\nberlin,1\nrome,2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": source_path.name, "path": str(source_path)},
        backend="polars",
        page_size=1,
    )
    session_id = opened["metadata"]["sessionId"]
    filter_model = {"filters": [], "sort": []}
    preview = manager.preview_step(
        session_id,
        0,
        {
            "id": "drop-city",
            "kind": "dropColumns",
            "params": {"columns": [{"id": "c:source:0", "name": "city"}]},
        },
        0,
        1,
    )
    page = manager.get_page(session_id, preview["revision"], 0, 1, filter_model)
    snapshot = deepcopy(page)

    manager.apply_draft(session_id, preview["revision"], 0, 1)

    assert page == snapshot
    assert page["metadata"]["steps"] == []
    manager.close_all()
