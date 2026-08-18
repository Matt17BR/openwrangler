from __future__ import annotations

import pytest

from openwrangler_runtime.engines import EngineError
from openwrangler_runtime.session import SessionManager


@pytest.mark.parametrize("backend", ["pandas", "polars", "duckdb"])
def test_earlier_step_preview_uses_its_prefix_and_requires_host_transaction_to_apply(tmp_path, backend):
    path = tmp_path / f"earlier-step-{backend}.csv"
    path.write_text("value\n1.234\n2.345\n", encoding="utf-8")
    manager = SessionManager()
    opened = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        page_size=10,
    )
    session_id = opened["metadata"]["sessionId"]
    value = opened["metadata"]["schema"][0]
    source_ref = {"id": value["id"], "name": value["name"]}
    round_step = {
        "id": "round-value",
        "kind": "roundNumber",
        "params": {"column": source_ref, "decimals": 0},
    }
    clone_step = {
        "id": "clone-value",
        "kind": "cloneColumn",
        "params": {"column": source_ref, "newName": "copy"},
    }

    first_preview = manager.preview_step(session_id, 0, round_step, 0, 10)
    first_apply = manager.apply_draft(session_id, first_preview["revision"], 0, 10)
    second_preview = manager.preview_step(session_id, first_apply["revision"], clone_step, 0, 10)
    confirmed = manager.apply_draft(session_id, second_preview["revision"], 0, 10)

    replacement = {
        **round_step,
        "params": {"column": source_ref, "decimals": 2},
    }
    preview = manager.preview_step(
        session_id,
        confirmed["revision"],
        replacement,
        0,
        10,
        replace_step_id=round_step["id"],
    )

    assert preview["metadata"]["draftReplacesStepId"] == round_step["id"]
    assert preview["metadata"]["draftStep"] == replacement
    assert preview["metadata"]["steps"] == [round_step, clone_step]
    assert [column["id"] for column in preview["metadata"]["latestStepInputSchema"]] == [source_ref["id"]]
    assert preview["page"]["rows"][0]["values"][0]["display"] == "1.23"

    with pytest.raises(EngineError, match="host plan-rewrite transaction"):
        manager.apply_draft(session_id, preview["revision"], 0, 10)

    discarded = manager.discard_draft(session_id, preview["revision"], 0, 10)
    assert discarded["metadata"]["steps"] == [round_step, clone_step]
    assert "draftStep" not in discarded["metadata"]
