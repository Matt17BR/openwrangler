from __future__ import annotations

from typing import Any

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

    candidate_id = f"candidate-{backend}"
    candidate = manager.open_session(
        {"kind": "file", "label": path.name, "path": str(path)},
        backend=backend,
        mode="editing",
        requested_session_id=candidate_id,
        page_size=10,
        clone_from={"sessionId": session_id, "revision": discarded["revision"]},
    )
    replayed_replacement = manager.preview_step(candidate_id, candidate["metadata"]["revision"], replacement, 0, 10)
    replayed_replacement = manager.apply_draft(candidate_id, replayed_replacement["revision"], 0, 10)
    replayed_suffix = manager.preview_step(candidate_id, replayed_replacement["revision"], clone_step, 0, 10)
    replayed_suffix = manager.apply_draft(candidate_id, replayed_suffix["revision"], 0, 10)

    generated = execute_generated(backend, path, replayed_suffix["code"])
    assert generated[0]["value"] == pytest.approx(1.23)
    assert generated[0]["copy"] == pytest.approx(1.23)


@pytest.mark.parametrize("backend", ["polars", "duckdb"])
def test_private_plan_clone_rejects_a_changed_file_source(tmp_path, backend):
    path = tmp_path / f"clone-source-{backend}.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    source = {"kind": "file", "label": path.name, "path": str(path)}
    opened = manager.open_session(source, backend=backend, mode="editing", page_size=10)
    path.write_text("value\n10\n20\n", encoding="utf-8")

    with pytest.raises(EngineError, match="source file.*changed"):
        manager.open_session(
            source,
            backend=backend,
            mode="editing",
            requested_session_id=f"changed-{backend}",
            page_size=10,
            clone_from={"sessionId": opened["metadata"]["sessionId"], "revision": 0},
        )


def test_private_pandas_plan_clone_keeps_the_confirmed_eager_file_capture(tmp_path):
    path = tmp_path / "clone-source-pandas.csv"
    path.write_text("value\n1\n2\n", encoding="utf-8")
    manager = SessionManager()
    source = {"kind": "file", "label": path.name, "path": str(path)}
    opened = manager.open_session(source, backend="pandas", mode="editing", page_size=10)
    path.write_text("value\n10\n20\n", encoding="utf-8")

    cloned = manager.open_session(
        source,
        backend="pandas",
        mode="editing",
        requested_session_id="changed-pandas",
        page_size=10,
        clone_from={"sessionId": opened["metadata"]["sessionId"], "revision": 0},
    )

    assert [row["values"][0]["raw"] for row in cloned["page"]["rows"]] == [1, 2]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_private_plan_clone_keeps_the_confirmed_live_value_after_rebinding(monkeypatch, backend):
    import __main__

    variable_name = f"earlier_step_clone_{backend}"
    if backend == "pandas":
        pd = pytest.importorskip("pandas")
        original = pd.DataFrame({"value": [1, 2]})
        replacement = pd.DataFrame({"value": [10, 20]})
    else:
        pl = pytest.importorskip("polars")
        original = pl.DataFrame({"value": [1, 2]})
        replacement = pl.DataFrame({"value": [10, 20]})
    monkeypatch.setattr(__main__, variable_name, original, raising=False)
    source = {"kind": "notebookVariable", "label": variable_name, "variableName": variable_name}
    manager = SessionManager()
    opened = manager.open_session(source, backend=backend, mode="editing", page_size=10)
    monkeypatch.setattr(__main__, variable_name, replacement)

    cloned = manager.open_session(
        source,
        backend=backend,
        mode="editing",
        requested_session_id=f"live-clone-{backend}",
        page_size=10,
        clone_from={"sessionId": opened["metadata"]["sessionId"], "revision": 0},
    )

    assert [row["values"][0]["raw"] for row in cloned["page"]["rows"]] == [1, 2]


def execute_generated(backend: str, path: Any, code: str) -> list[dict[str, Any]]:
    namespace: dict[str, Any] = {}
    exec(compile(code, "<earlier-step-generated>", "exec"), namespace, namespace)
    if backend == "pandas":
        pd = pytest.importorskip("pandas")
        result = namespace["clean_data"](pd.read_csv(path))
        return result.to_dict(orient="records")
    if backend == "polars":
        pl = pytest.importorskip("polars")
        result = namespace["clean_data"](pl.scan_csv(path))
        return result.collect().to_dicts()
    duckdb = pytest.importorskip("duckdb")
    result = namespace["clean_data"](duckdb.read_csv(str(path)))
    return [dict(zip(result.columns, row, strict=True)) for row in result.fetchall()]
