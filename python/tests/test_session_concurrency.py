from __future__ import annotations

import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from copy import deepcopy
from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

from openwrangler_runtime import server
from openwrangler_runtime.engines import EngineError, EngineRegistry, PolarsEngine
from openwrangler_runtime.session import PySparkConnectStateLostError, SessionManager
from openwrangler_runtime.session_access import SessionRequestAdmission

CONCURRENCY_COMPLETION_TIMEOUT_SECONDS = 5


def test_invalidation_is_reentrant_with_a_queued_writer_and_active_profile() -> None:
    # A regressed admission wait would deadlock both threads. Keep that failure
    # bounded in an owned subprocess rather than leaving a test worker blocked.
    subprocess.run(
        [
            sys.executable,
            "-c",
            dedent("""
            import threading
            from openwrangler_runtime.session_access import SessionRequestAdmission

            admission = SessionRequestAdmission()
            entered = threading.Event()
            def writer():
                with admission.exclusive():
                    entered.set()

            with admission.shared(), admission.profile(object, lambda: None):
                worker = threading.Thread(target=writer)
                worker.start()
                with admission._admission_condition:
                    assert admission._admission_condition.wait_for(
                        lambda: admission._waiting_writers == 1, timeout=2
                    )
                with admission.invalidation():
                    assert not entered.is_set()
            worker.join(timeout=2)
            assert not worker.is_alive()
            assert entered.is_set()
        """),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS,
    )


def test_late_profile_state_loss_cannot_republish_invalidated_page_cache(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "profile-state-loss.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session({"kind": "file", "path": str(path)}, backend="pandas", page_size=1)
    session_id = opened["metadata"]["sessionId"]
    session = manager.sessions[session_id]
    classifying = threading.Event()
    release_classifier = threading.Event()

    class RemoteStateLoss(EngineError):
        pass

    def fail_profile(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        raise RemoteStateLoss("Synthetic remote state loss")

    def classify(error: Exception) -> str | None:
        if not isinstance(error, RemoteStateLoss):
            return None
        classifying.set()
        assert release_classifier.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
        return "state_lost"

    monkeypatch.setattr(session.engine, "summaries", fail_profile)
    monkeypatch.setattr(session.engine, "classify_request_failure", classify)
    model = {"filters": [], "sort": []}
    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            profile = executor.submit(
                server.dispatch,
                manager,
                {
                    "kind": "getSummary",
                    "sessionId": session_id,
                    "revision": 0,
                    "viewRequestId": "failed-profile",
                    "filterModel": model,
                },
                "profile-state-loss",
            )
            try:
                assert classifying.wait(CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
                metadata = manager._metadata

                def page_metadata(active: Any) -> dict[str, Any]:
                    result = metadata(active)
                    release_classifier.set()
                    # The profile lease has ended, but its classified invalidation
                    # must wait for this page's complete publication boundary.
                    with pytest.raises(TimeoutError):
                        profile.result(timeout=0.05)
                    return result

                with monkeypatch.context() as pending_page:
                    pending_page.setattr(manager, "_metadata", page_metadata)
                    page = server.dispatch(
                        manager,
                        {
                            "kind": "getPage",
                            "sessionId": session_id,
                            "revision": 0,
                            "viewRequestId": "cached-page",
                            "offset": 0,
                            "limit": 1,
                            "columnOffset": 0,
                            "columnLimit": 64,
                            "filterModel": model,
                        },
                        "page-state-loss",
                    )
                assert page["page"] is opened["page"]
                with pytest.raises(PySparkConnectStateLostError):
                    profile.result(timeout=CONCURRENCY_COMPLETION_TIMEOUT_SECONDS)
                assert session.page_cache == {}
                assert session.page_cache_bytes == 0
                assert session.filter_model == {**model, "logic": "and"}
            finally:
                release_classifier.set()
    finally:
        manager.close_all()


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
