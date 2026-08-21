from __future__ import annotations

import json
import re
from pathlib import Path

import duckdb
import pandas as pd
import polars as pl
import pytest

import openwrangler_runtime.engines.pandas_engine as pandas_engine
import openwrangler_runtime.notebook as notebook
from openwrangler_runtime.engines import EngineError, EngineRegistry
from openwrangler_runtime.engines.base import normalize_cell
from openwrangler_runtime.engines.pandas_engine import PandasEngine
from openwrangler_runtime.engines.polars_engine import PolarsEngine

ROW_AXIS_CONTRACT = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures" / "notebook-pandas-mime-v2-contract.json").read_text(
        encoding="utf-8"
    )
)


def _assert_shared_row_labels(rows, expected_rows):
    assert len(rows) == len(expected_rows)
    for row, expected in zip(rows, expected_rows, strict=True):
        expects_label = "rowLabel" in expected
        assert ("rowLabel" in row) is expects_label
        if expects_label:
            assert row["rowLabel"] == expected["rowLabel"]


@pytest.mark.parametrize(
    ("value", "backend"),
    [
        (pd.DataFrame({"value": [1, 2]}), "pandas"),
        (pl.DataFrame({"value": [1, 2]}), "polars"),
        (duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)"), "duckdb"),
    ],
)
def test_show_emits_complete_mime_v2_snapshot(value, backend, monkeypatch):
    captured = []
    monkeypatch.setattr(notebook, "display", lambda payload, raw: captured.append((payload, raw)))
    if backend == "polars":
        monkeypatch.setattr(
            pl.DataFrame,
            "to_pandas",
            lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must stay native")),
            raising=False,
        )
    if backend == "duckdb":
        _install_duckdb_conversion_guards(monkeypatch)

    notebook.show(value, label="frame", variable_name="df")
    payload, raw = captured[0]
    snapshot = payload[notebook.MIME_TYPE_V2]

    assert raw is True
    assert snapshot["mimeVersion"] == 2
    assert snapshot["metadata"]["protocolVersion"] == 2
    assert snapshot["metadata"]["backend"] == backend
    assert snapshot["metadata"]["source"]["variableName"] == "df"
    assert snapshot["metadata"]["mode"] == "viewing"
    assert snapshot["metadata"]["steps"] == []
    assert "stats" not in snapshot["metadata"]
    assert snapshot["summaries"] == []
    assert snapshot["page"]["rows"][1]["values"][0]["display"] == "2"


def test_pandas_snapshot_matches_the_shared_row_axis_contract():
    frames = {
        "positional-range-index": pd.DataFrame({"value": [1, 2]}),
        "named-index": pd.DataFrame(
            {"value": [1, 2]},
            index=pd.Index([10, 20], name="record_id"),
        ),
        "one-level-multi-index": pd.DataFrame(
            {"value": [1, 2]},
            index=pd.MultiIndex.from_arrays(
                [["north", "south"]],
                names=["region"],
            ),
        ),
        "named-multi-index": pd.DataFrame(
            {"value": [1, 2]},
            index=pd.MultiIndex.from_tuples(
                [("north", 1), ("south", 2)],
                names=["region", "sequence"],
            ),
        ),
    }

    assert ROW_AXIS_CONTRACT["schemaVersion"] == 1
    assert [case["name"] for case in ROW_AXIS_CONTRACT["pandasRowAxisCases"]] == list(frames)
    for case in ROW_AXIS_CONTRACT["pandasRowAxisCases"]:
        payload = notebook.build_payload(frames[case["name"]], backend="pandas", page_size=2)

        assert payload["metadata"]["rowAxis"] == case["rowAxis"]
        _assert_shared_row_labels(payload["page"]["rows"], case["expectedRows"])
        if case["rowAxis"]["kind"] == "positional":
            explicit_null_rows = [{**row, "rowLabel": None} for row in payload["page"]["rows"]]
            with pytest.raises(AssertionError):
                _assert_shared_row_labels(explicit_null_rows, case["expectedRows"])


def test_pandas_row_axis_formatter_preserves_bounded_normalized_displays():
    values = [
        None,
        True,
        42,
        1.25,
        b"\x00\xff",
        "line\nvalue",
        ["north", 1, None, True],
        ['quote"\n\\', b"\x00"],
        ("north", 1),
        {"region": "north", "sequence": 1, "missing": None},
    ]
    for value in values:
        cell = normalize_cell(value)
        expected = "null" if cell["isNull"] else cell["display"]
        assert pandas_engine._pandas_row_axis_value(value, "Pandas row-index label") == expected

    assert pandas_engine._pandas_row_axis_value("x" * 1_024, "Pandas row-index label") == "x" * 1_024
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_value("x" * 1_025, "Pandas row-index label")

    multi_index_axis = {"kind": "multiIndex", "levelNames": [None, None]}
    assert len(pandas_engine._pandas_row_axis_label(("x" * 512, "y" * 509), multi_index_axis)) == 1_024
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_label(("x" * 512, "y" * 510), multi_index_axis)


def test_pandas_row_axis_formatter_stops_before_oversized_allocations(monkeypatch):
    normalized = []
    encoded = []
    original_normalize_cell = pandas_engine.normalize_cell
    original_b64encode = pandas_engine.b64encode

    def observe_normalize_cell(value):
        normalized.append(value)
        return original_normalize_cell(value)

    def observe_b64encode(value):
        encoded.append(value)
        return original_b64encode(value)

    monkeypatch.setattr(pandas_engine, "normalize_cell", observe_normalize_cell)
    monkeypatch.setattr(pandas_engine, "b64encode", observe_b64encode)

    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_value(b"x" * 769, "Pandas row-index label")
    assert encoded == []
    assert normalized == []

    assert len(pandas_engine._pandas_row_axis_value(b"x" * 768, "Pandas row-index label")) == 1_024
    assert len(encoded) == 1
    assert len(pandas_engine._pandas_row_axis_value([b"x" * 765], "Pandas row-index label")) == 1_024
    assert len(encoded) == 2
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_value([b"x" * 766], "Pandas row-index label")
    assert len(encoded) == 2

    assert len(pandas_engine._pandas_row_axis_value(["x" * 1_020], "Pandas row-index label")) == 1_024
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_value(["x" * 1_021], "Pandas row-index label")

    assert len(pandas_engine._pandas_row_axis_value(10**1_023, "Pandas row-index label")) == 1_024
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        pandas_engine._pandas_row_axis_value(10**1_024, "Pandas row-index label")

    compounds = [
        [""] * 400 + [7],
        tuple([""] * 400 + [7]),
        {**{f"key-{index}": "" for index in range(200)}, "probe": 7},
    ]
    for compound in compounds:
        normalized.clear()
        with pytest.raises(EngineError, match="exceeds 1024 characters"):
            pandas_engine._pandas_row_axis_value(compound, "Pandas row-index label")
        assert normalized == []

    nested = "leaf"
    for _ in range(65):
        nested = [nested]
    with pytest.raises(EngineError, match="exceeds 64 nested values"):
        pandas_engine._pandas_row_axis_value(nested, "Pandas row-index label")

    recursive = []
    recursive.append(recursive)
    with pytest.raises(EngineError, match="cyclic compound value"):
        pandas_engine._pandas_row_axis_value(recursive, "Pandas row-index label")


def test_pandas_row_axis_formatter_enforces_the_graph_node_budget_before_reading_the_next_value(monkeypatch):
    normalized = []
    original_normalize_cell = pandas_engine.normalize_cell

    def observe_normalize_cell(value):
        normalized.append(value)
        return original_normalize_cell(value)

    monkeypatch.setattr(pandas_engine, "normalize_cell", observe_normalize_cell)
    monkeypatch.setattr(pandas_engine, "_MAX_ROW_AXIS_TEXT_CHARACTERS", 10_000)
    with pytest.raises(EngineError, match="exceeds 1024 compound values"):
        pandas_engine._pandas_row_axis_value([None] * 1_024, "Pandas row-index label")
    assert len(normalized) == 1_023


def test_pandas_row_axis_formatter_rejects_unknown_displays_without_stringifying_them():
    class HostileDisplay:
        def __str__(self):
            raise AssertionError("Unknown row-axis values must not be stringified")

    with pytest.raises(EngineError, match="unsupported display value"):
        pandas_engine._pandas_row_axis_value(HostileDisplay(), "Pandas row-index label")

    with pytest.raises(EngineError, match="unsupported mapping key"):
        pandas_engine._pandas_row_axis_value({HostileDisplay(): "value"}, "Pandas row-index label")


def test_pandas_snapshot_rejects_an_oversized_binary_index_before_base64_allocation(monkeypatch):
    encoded = []
    original_b64encode = pandas_engine.b64encode

    def observe_b64encode(value):
        encoded.append(value)
        return original_b64encode(value)

    monkeypatch.setattr(pandas_engine, "b64encode", observe_b64encode)
    frame = pd.DataFrame(
        {"value": [1]},
        index=pd.Index(pd.Series([b"x" * 769], dtype="object"), name="binary_key"),
    )
    with pytest.raises(EngineError, match="exceeds 1024 characters"):
        notebook.build_payload(frame, backend="pandas", page_size=1)
    assert encoded == []


def test_ordinary_tuple_valued_index_keeps_its_tuple_label_representation():
    tuple_index = pd.Index(
        pd.Series([("north", 1), ("south", 2)], dtype="object"),
        name="tuple_key",
    )
    payload = notebook.build_payload(
        pd.DataFrame({"value": [1, 2]}, index=tuple_index),
        backend="pandas",
        page_size=2,
    )

    assert payload["metadata"]["rowAxis"] == {"kind": "index", "levelNames": ["tuple_key"]}
    assert [row["rowLabel"] for row in payload["page"]["rows"]] == ['["north",1]', '["south",2]']


def test_non_pandas_snapshots_match_the_shared_row_axis_omission_contract():
    frames = {
        "polars": pl.DataFrame({"value": [1, 2]}),
        "duckdb": duckdb.sql("SELECT * FROM (VALUES (1), (2)) AS source(value)"),
    }

    assert ROW_AXIS_CONTRACT["nonPandasBackends"] == list(frames)
    for backend in ROW_AXIS_CONTRACT["nonPandasBackends"]:
        payload = notebook.build_payload(frames[backend], backend=backend, page_size=2)

        assert "rowAxis" not in payload["metadata"]


def test_duckdb_snapshot_uses_the_originating_connection_without_conversion(monkeypatch):
    _install_duckdb_conversion_guards(monkeypatch)
    connection = duckdb.connect()
    connection.execute("CREATE TABLE private_orders AS SELECT 7 AS order_id UNION ALL SELECT 11")
    relation = connection.table("private_orders")

    try:
        payload = notebook.build_payload(relation, label="orders", variable_name="orders")

        assert payload["metadata"]["backend"] == "duckdb"
        assert payload["metadata"]["shape"] == {"rows": 2, "columns": 1}
        assert [row["values"][0]["display"] for row in payload["page"]["rows"]] == ["7", "11"]
        # Snapshot cleanup releases only Open Wrangler's owner. The notebook's
        # relation and originating connection remain fully usable.
        assert relation.fetchall() == [(7,), (11,)]
    finally:
        connection.close()


def test_pandas_mixed_object_snapshot_preserves_cell_kinds_under_string_semantics():
    payload = notebook.build_payload(pd.DataFrame({"value": pd.Series([1, "1"], dtype="object")}), backend="pandas")

    assert payload["metadata"]["schema"][0]["type"] == "string"
    assert [row["values"][0]["kind"] for row in payload["page"]["rows"]] == ["integer", "string"]


def test_notebook_snapshot_validates_options():
    with pytest.raises(EngineError, match="variable_name"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), variable_name="not valid")
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), page_size=0)
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), page_size=10_001)


def test_notebook_snapshot_limits_variable_name_before_engine_work(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"variable_name.*at most 4 characters"):
        notebook.build_payload(pd.DataFrame({"value": [1]}), label="data", variable_name="valid")


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_enforces_dimension_and_byte_budgets(backend, monkeypatch):
    assert notebook.MAX_SAVED_ROWS == 10_000
    assert notebook.MAX_SAVED_COLUMNS == 2_048
    assert notebook.MAX_SAVED_CELLS == 100_000
    assert notebook.MAX_SAVED_PAYLOAD_BYTES == 16_777_216
    assert notebook.MAX_SAVED_LABEL_CHARACTERS == 256
    assert notebook.MAX_SAVED_COLUMN_CHARACTERS == 512
    assert notebook.MAX_SAVED_CELL_CHARACTERS == 65_536
    assert notebook.MAX_SAVED_PAYLOAD_NODES == 1_000_000
    assert notebook.MAX_SAVED_PAYLOAD_DEPTH == 64

    monkeypatch.setattr(notebook, "MAX_SAVED_ROWS", 2)
    notebook.build_payload(_frame(backend, 2, 1), backend=backend, page_size=2)
    with pytest.raises(EngineError, match="page_size"):
        notebook.build_payload(_frame(backend, 3, 1), backend=backend, page_size=3)

    monkeypatch.setattr(notebook, "MAX_SAVED_ROWS", 10_000)
    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMNS", 2)
    notebook.build_payload(_frame(backend, 1, 2), backend=backend)
    with pytest.raises(EngineError, match="at most 2 columns"):
        notebook.build_payload(_frame(backend, 1, 3), backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMNS", 2_048)
    monkeypatch.setattr(notebook, "MAX_SAVED_CELLS", 4)
    notebook.build_payload(_frame(backend, 2, 2), backend=backend, page_size=2)
    bounded = notebook.build_payload(_frame(backend, 3, 2), backend=backend, page_size=3)
    assert len(bounded["page"]["rows"]) == 2
    assert bounded["page"]["totalRows"] == 3

    monkeypatch.setattr(notebook, "MAX_SAVED_CELLS", 100_000)
    payload = notebook.build_payload(_frame(backend, 1, 1), backend=backend)
    payload["metadata"]["source"]["label"] = ""
    base_size = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", base_size + 8)
    payload["metadata"]["source"]["label"] = "x" * 8
    notebook._validate_snapshot_payload_size(payload)
    payload["metadata"]["source"]["label"] += "x"
    with pytest.raises(EngineError, match="serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


def test_notebook_snapshot_counts_incremental_utf8_at_the_exact_boundary(monkeypatch):
    payload = {"value": "😀" * 20_000}
    serialized_size = len(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )

    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", serialized_size)
    notebook._validate_snapshot_payload_size(payload)

    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_BYTES", serialized_size - 1)
    with pytest.raises(EngineError, match=rf"at most {serialized_size - 1:,} serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


def test_notebook_snapshot_aborts_repeated_maximum_cells_without_a_full_json_dump(monkeypatch):
    payload = notebook.build_payload(pd.DataFrame({"value": ["seed"]}), backend="pandas")
    maximum_text = "x" * notebook.MAX_SAVED_CELL_CHARACTERS
    row_count = notebook.MAX_SAVED_ROWS
    payload["metadata"]["shape"]["rows"] = row_count
    payload["metadata"]["filteredShape"]["rows"] = row_count
    payload["page"].update(
        {
            "limit": row_count,
            "totalRows": row_count,
            "rows": [
                {
                    "id": f"r:{row_number}",
                    "rowNumber": row_number,
                    "values": [
                        {
                            "kind": "string",
                            "raw": maximum_text,
                            "display": maximum_text,
                            "isNull": False,
                            "isNaN": False,
                        }
                    ],
                }
                for row_number in range(row_count)
            ],
        }
    )
    assert row_count * len(maximum_text) * 2 > 1_000_000_000

    def reject_full_dump(*_args, **_kwargs):
        raise AssertionError("Notebook payload validation must not materialize a complete JSON dump.")

    monkeypatch.setattr(notebook.json, "dumps", reject_full_dump)

    with pytest.raises(EngineError, match=r"at most 16,777,216 serialized bytes"):
        notebook._validate_snapshot_payload_size(payload)


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_enforces_label_column_and_cell_text_budgets(backend, monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"label.*at most 4 characters"):
        notebook.build_payload(_frame(backend, 1, 1), label="12345", backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_LABEL_CHARACTERS", 256)
    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMN_CHARACTERS", 8)
    with pytest.raises(EngineError, match=r"column 1 name.*at most 8 characters"):
        notebook.build_payload(_text_frame(backend, "123456789", "ok"), backend=backend)

    monkeypatch.setattr(notebook, "MAX_SAVED_COLUMN_CHARACTERS", 512)
    monkeypatch.setattr(notebook, "MAX_SAVED_CELL_CHARACTERS", 4)
    with pytest.raises(EngineError, match=r"cell at row 1, column 1 display.*at most 4 characters"):
        notebook.build_payload(_text_frame(backend, "value", "12345"), backend=backend)


def test_notebook_snapshot_enforces_nested_string_and_key_budgets(monkeypatch):
    payload = notebook.build_payload(pd.DataFrame({"value": ["ok"]}), backend="pandas")
    cell = payload["page"]["rows"][0]["values"][0]
    cell["display"] = "ok"
    cell["raw"] = {"12345": ["12345"]}
    monkeypatch.setattr(notebook, "MAX_SAVED_CELL_CHARACTERS", 4)

    with pytest.raises(EngineError, match=r"nested key.*at most 4 characters"):
        notebook._validate_snapshot_fields(payload["metadata"], payload["page"])


def test_notebook_snapshot_enforces_payload_depth_at_the_exact_boundary(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_DEPTH", 3)
    notebook._validate_snapshot_payload_size(_nested_lists(3))

    with pytest.raises(EngineError, match=r"at most 3 nested payload levels.*depth 4"):
        notebook._validate_snapshot_payload_size(_nested_lists(4))


def test_notebook_snapshot_enforces_payload_node_count_at_the_exact_boundary(monkeypatch):
    monkeypatch.setattr(notebook, "MAX_SAVED_PAYLOAD_NODES", 4)
    notebook._validate_snapshot_payload_size([1, 2, 3])

    with pytest.raises(EngineError, match=r"at most 4 payload nodes.*at least 5"):
        notebook._validate_snapshot_payload_size([1, 2, 3, 4])


def test_notebook_snapshot_translates_engine_recursion_failures(monkeypatch):
    monkeypatch.setattr(
        PandasEngine,
        "page",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RecursionError("nested value overflow")),
    )

    with pytest.raises(EngineError, match=r"nested too deeply.*at most 64") as caught:
        notebook.build_payload(pd.DataFrame({"value": [1]}), backend="pandas")
    assert isinstance(caught.value.__cause__, RecursionError)


@pytest.mark.parametrize("depth", [65, 1_100])
def test_notebook_snapshot_rejects_real_excessively_nested_cells(depth):
    frame = pd.DataFrame({"value": [_nested_lists(depth)]})

    with pytest.raises(EngineError, match=r"nested (?:payload levels|too deeply)"):
        notebook.build_payload(frame, backend="pandas")


def test_notebook_snapshot_keeps_polars_lazyframe_native_and_collects_only_bounded_results(monkeypatch):
    lazy = pl.DataFrame({"value": list(range(20)), "unused": ["x"] * 20}).lazy()
    collected_heights = []
    original_collect = pl.LazyFrame.collect

    def guarded_collect(frame, *args, **kwargs):
        result = original_collect(frame, *args, **kwargs)
        assert isinstance(result, pl.DataFrame)
        collected_heights.append(result.height)
        return result

    monkeypatch.setattr(pl.LazyFrame, "collect", guarded_collect)
    monkeypatch.setattr(
        PolarsEngine,
        "normalize",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("A notebook LazyFrame must not use eager normalize")
        ),
    )

    payload = notebook.build_payload(lazy, backend="polars", page_size=3)

    assert payload["metadata"]["shape"] == {"rows": 20, "columns": 2}
    assert payload["metadata"]["filteredShape"] == {"rows": 20, "columns": 2}
    assert payload["page"]["totalRows"] == 20
    assert len(payload["page"]["rows"]) == 3
    assert [row["values"][0]["display"] for row in payload["page"]["rows"]] == ["0", "1", "2"]
    assert collected_heights == [1, 3]


@pytest.mark.parametrize("backend", ["pandas", "polars"])
def test_notebook_snapshot_does_not_eagerly_profile_full_data(backend, monkeypatch):
    engine_type = PandasEngine if backend == "pandas" else PolarsEngine
    monkeypatch.setattr(
        engine_type,
        "header_stats",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must profile progressively")),
    )
    monkeypatch.setattr(
        engine_type,
        "summaries",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Notebook output must profile progressively")),
    )

    payload = notebook.build_payload(_frame(backend, 2, 1), backend=backend)

    assert "stats" not in payload["metadata"]
    assert payload["summaries"] == []


def test_notebook_snapshot_preserves_backend_detection_faults(monkeypatch):
    def broken_factory():
        raise RuntimeError("factory exploded")

    monkeypatch.setattr(notebook, "default_engine_registry", lambda: EngineRegistry((("broken", broken_factory),)))

    with pytest.raises(EngineError, match=r"broken.*factory exploded") as caught:
        notebook.build_payload(object())
    assert isinstance(caught.value.__cause__, RuntimeError)


def test_notebook_snapshot_translates_only_an_unsupported_value():
    with pytest.raises(EngineError, match="supports Pandas or Polars dataframes and series, and DuckDB relations"):
        notebook.build_payload(object())


class FakeFormatter:
    def __init__(self):
        self.registered = {}

    def for_type(self, value_type, formatter):
        self.registered[value_type] = formatter


class FakeHtmlFormatter(FakeFormatter):
    @property
    def type_printers(self):
        return self.registered


def test_formatter_registration_emits_v2_for_all_notebook_engines(monkeypatch):
    _install_duckdb_conversion_guards(monkeypatch)
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {"display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})()},
    )()
    assert notebook.register_formatters(shell) is True

    pandas_bundle = formatter.registered[pd.DataFrame](pd.DataFrame({"value": [1]}))
    polars_bundle = formatter.registered[pl.DataFrame](pl.DataFrame({"value": [1]}))
    duckdb_bundle = formatter.registered[duckdb.DuckDBPyRelation](duckdb.sql("SELECT 1 AS value"))
    assert pandas_bundle[notebook.MIME_TYPE_V2]["mimeVersion"] == 2
    assert polars_bundle[notebook.MIME_TYPE_V2]["mimeVersion"] == 2
    assert duckdb_bundle[notebook.MIME_TYPE_V2]["metadata"]["backend"] == "duckdb"


def test_formatter_links_one_canonical_user_variable_to_the_complete_live_value():
    formatter = FakeFormatter()
    frame = pd.DataFrame({"value": range(250)})
    shell = type(
        "FakeShell",
        (),
        {
            "user_ns": {"frame": frame, "_hidden": frame, "not valid": frame},
            "display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})(),
        },
    )()

    assert notebook.register_formatters(shell) is True
    payload = formatter.registered[pd.DataFrame](frame)[notebook.MIME_TYPE_V2]

    assert payload["metadata"]["source"]["variableName"] == "frame"
    assert payload["metadata"]["source"]["label"] == "frame"
    assert payload["metadata"]["shape"]["rows"] == 250
    assert len(payload["page"]["rows"]) == 200


def test_duckdb_formatter_links_the_exact_live_relation_without_conversion(monkeypatch):
    _install_duckdb_conversion_guards(monkeypatch)
    connection = duckdb.connect()
    connection.execute("CREATE TABLE private_orders AS SELECT 7 AS order_id UNION ALL SELECT 11")
    relation = connection.table("private_orders")
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {
            "user_ns": {"orders": relation},
            "display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})(),
        },
    )()

    try:
        assert notebook.register_formatters(shell) is True
        payload = formatter.registered[duckdb.DuckDBPyRelation](relation)[notebook.MIME_TYPE_V2]

        assert payload["metadata"]["backend"] == "duckdb"
        assert payload["metadata"]["source"]["variableName"] == "orders"
        assert [row["values"][0]["display"] for row in payload["page"]["rows"]] == ["7", "11"]
        assert relation.fetchall() == [(7,), (11,)]
    finally:
        connection.close()


@pytest.mark.parametrize(
    "value",
    [
        pd.DataFrame({"value": [1, 2]}).head(1),
        pl.DataFrame({"value": [1, 2]}).tail(1),
    ],
)
def test_formatter_links_temporary_results_through_an_opaque_weak_handle(value):
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {
            "user_ns": {},
            "display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})(),
        },
    )()

    assert notebook.register_formatters(shell) is True
    payload = formatter.registered[type(value)](value)[notebook.MIME_TYPE_V2]
    handle = payload["metadata"]["source"]["variableName"]

    assert re.fullmatch(r"__openwrangler_live_result_[0-9a-f]{32}", handle)
    assert payload["metadata"]["source"]["label"] == type(value).__name__
    assert notebook.resolve_live_result(handle) is value


def test_formatter_links_an_ambiguous_value_through_an_opaque_weak_handle():
    formatter = FakeFormatter()
    frame = pd.DataFrame({"value": [1]})
    shell = type(
        "FakeShell",
        (),
        {
            "user_ns": {"frame": frame, "alias": frame},
            "display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})(),
        },
    )()

    assert notebook.register_formatters(shell) is True
    payload = formatter.registered[pd.DataFrame](frame)[notebook.MIME_TYPE_V2]

    assert notebook.is_live_result_handle(payload["metadata"]["source"]["variableName"])
    assert notebook.resolve_live_result(payload["metadata"]["source"]["variableName"]) is frame
    assert payload["metadata"]["source"]["label"] == "DataFrame"


@pytest.mark.parametrize(
    ("value", "backend"),
    [
        (pd.DataFrame({"value": [1]}), "pandas"),
        (pl.DataFrame({"value": [1]}), "polars"),
        (duckdb.sql("SELECT 1 AS value"), "duckdb"),
    ],
)
def test_link_live_result_returns_a_native_live_source_without_serializing(value, backend):
    shell = type("FakeShell", (), {"user_ns": {"frame": value}})()

    linked = notebook.link_live_result(value, shell)

    assert linked["protocolVersion"] == 1
    assert linked["backend"] == backend
    assert linked["label"] == "frame"
    handle = linked["variableName"]
    assert isinstance(handle, str)
    assert notebook.is_live_result_handle(handle)
    assert notebook.resolve_live_result(handle) is value


def test_link_live_result_handle_survives_rebinding_the_canonical_name():
    original = pd.DataFrame({"value": [1]})
    replacement = pd.DataFrame({"value": [2]})
    namespace = {"frame": original}
    shell = type("FakeShell", (), {"user_ns": namespace})()

    linked = notebook.link_live_result(original, shell)
    namespace["frame"] = replacement

    assert linked["label"] == "frame"
    handle = linked["variableName"]
    assert isinstance(handle, str)
    assert notebook.resolve_live_result(handle) is original


def test_link_live_result_reuses_one_handle_for_repeated_opens():
    frame = pd.DataFrame({"value": [1]})
    shell = type("FakeShell", (), {"user_ns": {"Out": {7: frame}}})()

    first = notebook.link_live_result(frame, shell)
    second = notebook.link_live_result(frame, shell)

    assert second["variableName"] == first["variableName"]
    handle = first["variableName"]
    assert isinstance(handle, str)
    assert notebook.resolve_live_result(handle) is frame


def test_link_live_result_keeps_an_unassigned_cell_result_alive_only_through_its_opaque_handle():
    frame = pd.DataFrame({"value": [1]})
    shell = type("FakeShell", (), {"user_ns": {"Out": {7: frame}}})()

    linked = notebook.link_live_result(frame, shell)

    assert linked["backend"] == "pandas"
    assert linked["label"] == "DataFrame"
    handle = linked["variableName"]
    assert isinstance(handle, str)
    assert notebook.is_live_result_handle(handle)
    assert notebook.resolve_live_result(handle) is frame


def test_link_live_result_rejects_non_dataframe_results():
    shell = type("FakeShell", (), {"user_ns": {}})()

    with pytest.raises(EngineError, match="not a supported"):
        notebook.link_live_result([1, 2, 3], shell)


def test_formatter_registration_prefers_open_wrangler_without_overriding_explicit_html():
    formatter = FakeFormatter()
    html_formatter = FakeHtmlFormatter()

    def explicit_series_html(_value):
        return "<strong>user formatter</strong>"

    html_formatter.for_type(pd.Series, explicit_series_html)
    shell = type(
        "FakeShell",
        (),
        {
            "display_formatter": type(
                "DisplayFormatter",
                (),
                {
                    "mimebundle_formatter": formatter,
                    "formatters": {"text/html": html_formatter},
                },
            )()
        },
    )()

    assert notebook.register_formatters(shell) is True

    assert html_formatter.registered[pd.DataFrame](pd.DataFrame({"value": [1]})) is None
    assert html_formatter.registered[pd.Series] is explicit_series_html
    assert html_formatter.registered[pd.Series](pd.Series([1])) == "<strong>user formatter</strong>"


def test_formatter_reduces_wide_capture_rows_to_the_cell_budget():
    formatter = FakeFormatter()
    shell = type(
        "FakeShell",
        (),
        {"display_formatter": type("DisplayFormatter", (), {"mimebundle_formatter": formatter})()},
    )()
    assert notebook.register_formatters(shell) is True
    frame = pd.DataFrame({f"c{column}": range(200) for column in range(501)})

    payload = formatter.registered[pd.DataFrame](frame)[notebook.MIME_TYPE_V2]

    assert payload["page"]["limit"] == notebook.MAX_SAVED_CELLS // 501
    assert len(payload["page"]["rows"]) == notebook.MAX_SAVED_CELLS // 501
    assert payload["page"]["totalRows"] == 200


def _frame(backend: str, rows: int, columns: int):
    values = {f"c{column}": list(range(rows)) for column in range(columns)}
    return pd.DataFrame(values) if backend == "pandas" else pl.DataFrame(values)


def _text_frame(backend: str, column: str, value: str):
    values = {column: [value]}
    return pd.DataFrame(values) if backend == "pandas" else pl.DataFrame(values)


def _install_duckdb_conversion_guards(monkeypatch):
    def reject_conversion(*_args, **_kwargs):
        raise AssertionError("DuckDB notebook output must never convert through Pandas, Polars, or Arrow")

    for method in ("df", "to_df", "fetchdf", "pl", "arrow"):
        monkeypatch.setattr(duckdb.DuckDBPyRelation, method, reject_conversion)


def _nested_lists(depth: int):
    value = "leaf"
    for _ in range(depth):
        value = [value]
    return value
