from __future__ import annotations

import pytest

from openwrangler_runtime import SessionManager, __version__
from openwrangler_runtime.limits import MAX_VIEW_VALUE_TEXT_CHARACTERS
from openwrangler_runtime.protocol import MAX_PAGE_LIMIT, ProtocolError, decode_envelope


def test_initialize_advertises_the_canonical_runtime_version() -> None:
    assert SessionManager().initialize()["runtimeVersion"] == __version__


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


def test_open_session_accepts_only_a_non_empty_requested_session_identity() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "open-1",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.csv", "path": "/tmp/sample.csv"},
            "requestedSessionId": "candidate-session",
            "pageSize": 200,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    }

    assert decode_envelope(envelope)[2]["requestedSessionId"] == "candidate-session"
    envelope["request"]["requestedSessionId"] = ""
    with pytest.raises(ProtocolError, match="requestedSessionId must be a non-empty string"):
        decode_envelope(envelope)


def test_open_session_accepts_supported_backends_and_scopes_pyspark_to_live_notebooks() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "open-duckdb",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": {"kind": "file", "label": "sample.parquet", "path": "/tmp/sample.parquet"},
            "backend": "duckdb",
            "pageSize": 200,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    }

    assert decode_envelope(envelope)[2]["backend"] == "duckdb"
    envelope["request"]["backend"] = "pyspark"
    with pytest.raises(ProtocolError, match="only live notebookVariable sources"):
        decode_envelope(envelope)

    envelope["request"]["source"] = {
        "kind": "notebookVariable",
        "label": "spark_frame",
        "variableName": "spark_frame",
    }
    assert decode_envelope(envelope)[2]["backend"] == "pyspark"
    envelope["request"]["mode"] = "editing"
    with pytest.raises(ProtocolError, match="only viewing mode"):
        decode_envelope(envelope)
    envelope["request"]["mode"] = "viewing"
    assert decode_envelope(envelope)[2]["mode"] == "viewing"

    envelope["request"]["backend"] = "sqlite"
    with pytest.raises(ProtocolError, match="pandas, polars, duckdb, or pyspark"):
        decode_envelope(envelope)


def _open_session_envelope_with_import_options(
    import_options: object,
    file_name: str = "sample.csv",
    *,
    source_location: dict[str, str] | None = None,
) -> dict[str, object]:
    source: dict[str, object] = {
        "kind": "file",
        "label": file_name,
        "importOptions": import_options,
    }
    if source_location is None:
        source["path"] = f"/tmp/{file_name}"
    else:
        source.update(source_location)
    return {
        "protocolVersion": 2,
        "requestId": "open-import-options",
        "priority": "interactive",
        "request": {
            "kind": "openSession",
            "source": source,
            "pageSize": 200,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    }


@pytest.mark.parametrize(
    ("import_options", "file_name"),
    [
        ({}, "sample.csv"),
        ({"delimiter": "💠", "encoding": " utf-8 ", "quoteChar": "“", "hasHeader": True}, "sample.csv"),
        ({"sheetName": " résumé "}, "sample.xlsx"),
        ({"sheetIndex": 0}, "sample.xls"),
    ],
)
def test_open_session_accepts_strict_import_options(import_options: object, file_name: str) -> None:
    envelope = _open_session_envelope_with_import_options(import_options, file_name)

    assert decode_envelope(envelope)[2]["source"]["importOptions"] == import_options


def test_open_session_normalizes_integral_json_sheet_indices() -> None:
    envelope = _open_session_envelope_with_import_options({"sheetIndex": 1.0}, "sample.xlsx")

    decoded = decode_envelope(envelope)[2]["source"]["importOptions"]["sheetIndex"]

    assert decoded == 1
    assert isinstance(decoded, int)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("unexpected", True, "source contains unknown fields: unexpected"),
        ("path", 17, "source.path must be a string"),
        ("uri", 17, "source.uri must be a string"),
        ("variableName", 17, "source.variableName must be a string"),
    ],
)
def test_open_session_source_matches_the_exact_schema(field: str, value: object, message: str) -> None:
    envelope = _open_session_envelope_with_import_options({"delimiter": ","})
    request = envelope["request"]
    assert isinstance(request, dict)
    source = request["source"]
    assert isinstance(source, dict)
    source[field] = value

    with pytest.raises(ProtocolError, match=message):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    ("file_name", "source_location", "import_options"),
    [
        (
            "fallback.parquet",
            {"path": "/tmp/data#1.csv", "uri": "file:///tmp/fallback.xlsx?download=1"},
            {"delimiter": ";"},
        ),
        (
            "fallback.csv",
            {"path": "/tmp/data?1.xlsx", "uri": "file:///tmp/fallback.csv?download=1"},
            {"sheetIndex": 0},
        ),
        ("data#1.csv", {}, {"encoding": "utf-8"}),
        ("data?1.xlsx", {}, {"sheetName": "Sheet1"}),
        (
            "fallback.xlsx",
            {"uri": "file:///tmp/data.csv?download=1#section"},
            {"quoteChar": '"'},
        ),
        (
            "fallback.csv",
            {"path": "", "uri": "file:///tmp/data.XLSX#section?download=1"},
            {"sheetName": "Sheet1"},
        ),
    ],
)
def test_open_session_resolves_import_format_without_stripping_raw_path_or_label_markers(
    file_name: str, source_location: dict[str, str], import_options: dict[str, object]
) -> None:
    envelope = _open_session_envelope_with_import_options(
        import_options,
        file_name,
        source_location=source_location,
    )

    assert decode_envelope(envelope)[2]["source"]["importOptions"] == import_options


@pytest.mark.parametrize(
    ("file_name", "source_location", "import_options"),
    [
        (
            "fallback.csv",
            {"path": "/tmp/data.csv?download=1", "uri": "file:///tmp/fallback.csv"},
            {"delimiter": ","},
        ),
        (
            "fallback.csv",
            {"uri": "file:///tmp/download?name=data.csv"},
            {"delimiter": ","},
        ),
        (
            "fallback.xlsx",
            {"path": "/tmp/data.parquet", "uri": "file:///tmp/data.xlsx"},
            {"sheetIndex": 0},
        ),
        (".csv", {}, {"delimiter": ","}),
    ],
)
def test_open_session_import_format_uses_path_then_uri_then_label(
    file_name: str, source_location: dict[str, str], import_options: dict[str, object]
) -> None:
    envelope = _open_session_envelope_with_import_options(
        import_options,
        file_name,
        source_location=source_location,
    )

    with pytest.raises(ProtocolError, match="not supported for this file format"):
        decode_envelope(envelope)


def test_open_session_allows_empty_import_options_only_on_non_file_sources() -> None:
    envelope = _open_session_envelope_with_import_options({})
    request = envelope["request"]
    assert isinstance(request, dict)
    request["source"] = {
        "kind": "notebookVariable",
        "label": "frame.csv",
        "variableName": "frame",
        "importOptions": {},
    }
    assert decode_envelope(envelope)[2]["source"]["importOptions"] == {}

    source = request["source"]
    assert isinstance(source, dict)
    source["importOptions"] = {"delimiter": ","}
    with pytest.raises(ProtocolError, match="only for file sources"):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    ("import_options", "message"),
    [
        (None, "source.importOptions must be a JSON object"),
        ([], "source.importOptions must be a JSON object"),
        ({"delimiter": ",", "extra": True}, "contains unknown fields: extra"),
        ({"sheet": 0}, "contains unknown fields: sheet"),
        ({"delimiter": 1}, "delimiter must contain exactly one Unicode code point"),
        ({"delimiter": ""}, "delimiter must contain exactly one Unicode code point"),
        ({"delimiter": "||"}, "delimiter must contain exactly one Unicode code point"),
        ({"delimiter": "\ud800"}, "delimiter must contain exactly one Unicode code point"),
        ({"delimiter": "\udfff"}, "delimiter must contain exactly one Unicode code point"),
        ({"quoteChar": 1}, "quoteChar must contain exactly one Unicode code point"),
        ({"quoteChar": ""}, "quoteChar must contain exactly one Unicode code point"),
        ({"quoteChar": '""'}, "quoteChar must contain exactly one Unicode code point"),
        ({"quoteChar": "\ud800"}, "quoteChar must contain exactly one Unicode code point"),
        ({"quoteChar": "\udfff"}, "quoteChar must contain exactly one Unicode code point"),
        ({"encoding": 1}, "encoding must be a non-empty string"),
        ({"encoding": " \t "}, "encoding must be a non-empty string"),
        ({"encoding": "\ufeff"}, "encoding must be a non-empty string"),
        ({"hasHeader": "yes"}, "hasHeader must be a boolean"),
        ({"sheetName": 1}, "sheetName must be a non-empty string"),
        ({"sheetName": " \n "}, "sheetName must be a non-empty string"),
        ({"sheetName": "\ufeff"}, "sheetName must be a non-empty string"),
        ({"sheetIndex": -1}, "sheetIndex must be a non-negative safe integer"),
        ({"sheetIndex": 1.5}, "sheetIndex must be a non-negative safe integer"),
        ({"sheetIndex": True}, "sheetIndex must be a non-negative safe integer"),
        (
            {"sheetIndex": 9_007_199_254_740_992},
            "sheetIndex must be a non-negative safe integer",
        ),
        (
            {"sheetName": "Sheet1", "sheetIndex": 0},
            "must contain only one of sheetName or sheetIndex",
        ),
        (
            {"sheetName": "Sheet1", "delimiter": ","},
            "must not mix Excel selectors with delimited-file options",
        ),
        (
            {"sheetIndex": 0, "encoding": "utf-8"},
            "must not mix Excel selectors with delimited-file options",
        ),
        (
            {"sheetName": "Sheet1", "quoteChar": '"'},
            "must not mix Excel selectors with delimited-file options",
        ),
        (
            {"sheetIndex": 0, "hasHeader": True},
            "must not mix Excel selectors with delimited-file options",
        ),
    ],
)
def test_open_session_rejects_malformed_import_options(import_options: object, message: str) -> None:
    with pytest.raises(ProtocolError, match=message):
        decode_envelope(_open_session_envelope_with_import_options(import_options))


@pytest.mark.parametrize(
    ("file_name", "import_options", "message"),
    [
        ("sample.csv", {"sheetName": "Sheet1"}, "Excel values for a delimited-file source"),
        ("sample.xlsx", {"delimiter": ","}, "delimited-file values for an Excel source"),
        ("sample.parquet", {"encoding": "utf-8"}, "not supported for this file format"),
    ],
)
def test_open_session_rejects_import_values_for_the_wrong_file_format(
    file_name: str, import_options: object, message: str
) -> None:
    with pytest.raises(ProtocolError, match=message):
        decode_envelope(_open_session_envelope_with_import_options(import_options, file_name))


@pytest.mark.parametrize("kind", ["getPage", "getSummary", "getDatasetStats", "getColumnValues"])
def test_view_queries_require_non_empty_view_request_ids(kind: str) -> None:
    request: dict[str, object] = {
        "kind": kind,
        "sessionId": "session-1",
        "revision": 0,
        "viewRequestId": "view-17",
        "filterModel": {"logic": "and", "filters": [], "sort": []},
    }
    if kind == "getPage":
        request.update(offset=0, limit=200, columnOffset=0, columnLimit=64)
    elif kind == "getColumnValues":
        request.update(column="city", limit=100)

    envelope = {
        "protocolVersion": 2,
        "requestId": "transport-1",
        "priority": "background" if kind != "getPage" else "interactive",
        "request": request,
    }
    assert decode_envelope(envelope)[2]["viewRequestId"] == "view-17"

    request.pop("viewRequestId")
    with pytest.raises(ProtocolError, match="viewRequestId"):
        decode_envelope(envelope)

    request["viewRequestId"] = ""
    with pytest.raises(ProtocolError, match="non-empty"):
        decode_envelope(envelope)


@pytest.mark.parametrize("kind", ["getPage", "getSummary", "getDatasetStats", "getColumnValues"])
def test_view_queries_reject_duplicate_sort_columns(kind: str) -> None:
    request: dict[str, object] = {
        "kind": kind,
        "sessionId": "session-1",
        "revision": 0,
        "viewRequestId": "view-17",
        "filterModel": {
            "filters": [],
            "sort": [
                {"column": "city", "direction": "asc", "nulls": "last"},
                {"column": "city", "direction": "desc", "nulls": "first"},
            ],
        },
    }
    if kind == "getPage":
        request.update(offset=0, limit=200, columnOffset=0, columnLimit=64)
    elif kind == "getColumnValues":
        request.update(column="city", limit=100)

    with pytest.raises(ProtocolError, match=r"filterModel\.sort contains duplicate columns"):
        decode_envelope(
            {
                "protocolVersion": 2,
                "requestId": "transport-1",
                "priority": "background" if kind != "getPage" else "interactive",
                "request": request,
            }
        )


def test_protocol_bounds_view_and_transform_filter_text_at_the_shared_limit() -> None:
    def filter_model(value: str, second_value: str, selected_value: str, *, transform: bool) -> dict[str, object]:
        column: object = {"id": "column:0", "name": "value"} if transform else "value"
        return {
            "filters": [
                {
                    "column": column,
                    "type": "decimal",
                    "valueFilter": {
                        "kind": "values",
                        "selectedValues": [selected_value],
                        "includeNulls": False,
                        "includeNaN": False,
                    },
                    "predicates": [
                        {
                            "kind": "predicate",
                            "operator": "between",
                            "value": value,
                            "secondValue": second_value,
                        }
                    ],
                }
            ],
            "sort": [],
        }

    def page_envelope(value: str, second_value: str, selected_value: str) -> dict[str, object]:
        return {
            "protocolVersion": 2,
            "requestId": "bounded-page",
            "priority": "interactive",
            "request": {
                "kind": "getPage",
                "sessionId": "session-1",
                "revision": 0,
                "viewRequestId": "view-bounded",
                "offset": 0,
                "limit": 200,
                "columnOffset": 0,
                "columnLimit": 64,
                "filterModel": filter_model(value, second_value, selected_value, transform=False),
            },
        }

    def preview_envelope(value: str, second_value: str, selected_value: str) -> dict[str, object]:
        return {
            "protocolVersion": 2,
            "requestId": "bounded-preview",
            "priority": "interactive",
            "request": {
                "kind": "previewStep",
                "sessionId": "session-1",
                "revision": 0,
                "step": {
                    "id": "filter",
                    "kind": "filterRows",
                    "params": {"filterModel": filter_model(value, second_value, selected_value, transform=True)},
                },
                "offset": 0,
                "limit": 200,
                "columnOffset": 0,
                "columnLimit": 64,
            },
        }

    cases = (
        (
            f"1e{'9' * (MAX_VIEW_VALUE_TEXT_CHARACTERS - 2)}",
            f"1e{'9' * (MAX_VIEW_VALUE_TEXT_CHARACTERS - 1)}",
        ),
        ("😀" * MAX_VIEW_VALUE_TEXT_CHARACTERS, "😀" * (MAX_VIEW_VALUE_TEXT_CHARACTERS + 1)),
    )
    for at_limit, over_limit in cases:
        assert decode_envelope(page_envelope(at_limit, at_limit, at_limit))[2]["kind"] == "getPage"
        for envelope in (
            page_envelope(over_limit, at_limit, at_limit),
            page_envelope(at_limit, over_limit, at_limit),
            page_envelope(at_limit, at_limit, over_limit),
        ):
            with pytest.raises(ProtocolError, match="must not exceed 65,536 Unicode code points"):
                decode_envelope(envelope)

        assert decode_envelope(preview_envelope(at_limit, at_limit, at_limit))[2]["step"]["kind"] == "filterRows"
        for envelope in (
            preview_envelope(over_limit, at_limit, at_limit),
            preview_envelope(at_limit, over_limit, at_limit),
            preview_envelope(at_limit, at_limit, over_limit),
        ):
            with pytest.raises(ProtocolError, match="must not exceed 65,536 Unicode code points"):
                decode_envelope(envelope)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("columnOffset", -1, "columnOffset must be a non-negative integer"),
        ("columnOffset", True, "columnOffset must be a non-negative integer"),
        ("columnLimit", 0, "columnLimit must be an integer between 1 and 256"),
        ("columnLimit", 257, "columnLimit must be an integer between 1 and 256"),
        ("columnLimit", True, "columnLimit must be an integer between 1 and 256"),
    ],
)
def test_page_column_windows_are_bounded_and_reject_booleans(field: str, value: object, message: str) -> None:
    request: dict[str, object] = {
        "kind": "getPage",
        "sessionId": "session-1",
        "revision": 0,
        "viewRequestId": "view-17",
        "offset": 0,
        "limit": 200,
        "columnOffset": 0,
        "columnLimit": 64,
        "filterModel": {"logic": "and", "filters": [], "sort": []},
    }
    request[field] = value

    with pytest.raises(ProtocolError, match=message):
        decode_envelope(
            {
                "protocolVersion": 2,
                "requestId": "transport-1",
                "priority": "interactive",
                "request": request,
            }
        )


@pytest.mark.parametrize(
    "kind",
    [
        "openSession",
        "getPage",
        "getColumnValues",
        "previewStep",
        "inspectStep",
        "applyDraft",
        "discardDraft",
        "undoStep",
    ],
)
def test_protocol_result_windows_accept_10000_and_reject_10001(kind: str) -> None:
    if kind == "openSession":
        field = "pageSize"
        request: dict[str, object] = {
            "kind": kind,
            "source": {"kind": "file", "label": "sample.csv", "path": "/tmp/sample.csv"},
            "pageSize": MAX_PAGE_LIMIT,
            "columnOffset": 0,
            "columnLimit": 64,
        }
    elif kind == "getColumnValues":
        field = "limit"
        request = {
            "kind": kind,
            "sessionId": "session-1",
            "revision": 0,
            "viewRequestId": "view-values",
            "column": "city",
            "filterModel": {"logic": "and", "filters": [], "sort": []},
            "limit": MAX_PAGE_LIMIT,
        }
    else:
        field = "limit"
        request = {
            "kind": kind,
            "sessionId": "session-1",
            "revision": 0,
            "offset": 0,
            "limit": MAX_PAGE_LIMIT,
            "columnOffset": 0,
            "columnLimit": 64,
        }
        if kind == "getPage":
            request.update(
                viewRequestId="view-page",
                filterModel={"logic": "and", "filters": [], "sort": []},
            )
        elif kind == "previewStep":
            request["step"] = {
                "id": "rename-1",
                "kind": "renameColumn",
                "params": {"column": {"id": "column:0", "name": "old"}, "newName": "new"},
            }
        elif kind == "inspectStep":
            request["stepId"] = "rename-1"

    envelope = {
        "protocolVersion": 2,
        "requestId": f"bounded-{kind}",
        "priority": "interactive",
        "request": request,
    }
    assert decode_envelope(envelope)[2][field] == MAX_PAGE_LIMIT

    request[field] = MAX_PAGE_LIMIT + 1
    message = (
        f"inspectStep limit must not exceed {MAX_PAGE_LIMIT}"
        if kind == "inspectStep"
        else f"{field} must not exceed {MAX_PAGE_LIMIT}"
    )
    with pytest.raises(ProtocolError, match=message):
        decode_envelope(envelope)


def test_protocol_v2_validates_transformation_steps() -> None:
    _, _, request = decode_envelope(
        {
            "protocolVersion": 2,
            "requestId": "preview-1",
            "priority": "interactive",
            "request": {
                "kind": "previewStep",
                "sessionId": "session-1",
                "revision": 0,
                "step": {
                    "id": "rename-1",
                    "kind": "renameColumn",
                    "params": {"column": {"id": "column:0", "name": "old"}, "newName": "new"},
                },
                "offset": 0,
                "limit": 200,
                "columnOffset": 0,
                "columnLimit": 64,
            },
        }
    )

    assert request["step"]["kind"] == "renameColumn"


@pytest.mark.parametrize(
    "step",
    [
        {
            "id": "select",
            "kind": "selectColumns",
            "params": {"columns": [{"id": "column:0", "name": "value"}]},
        },
        {
            "id": "drop",
            "kind": "dropColumns",
            "params": {"columns": [{"id": "column:0", "name": "value"}]},
        },
        {
            "id": "rename",
            "kind": "renameColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "newName": "amount"},
        },
        {
            "id": "clone",
            "kind": "cloneColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "newName": "copy"},
        },
        {
            "id": "cast",
            "kind": "castColumn",
            "params": {"column": {"id": "column:0", "name": "value"}, "dtype": "float"},
        },
        {
            "id": "formula-value",
            "kind": "formula",
            "params": {
                "leftColumn": {"id": "column:0", "name": "value"},
                "operator": "multiply",
                "value": 2,
                "newColumn": "doubled",
            },
        },
        {
            "id": "formula-column",
            "kind": "formula",
            "params": {
                "leftColumn": {"id": "column:0", "name": "value"},
                "operator": "add",
                "rightColumn": {"id": "column:1", "name": "other"},
                "newColumn": "total",
            },
        },
        {
            "id": "length-empty-name",
            "kind": "textLength",
            "params": {"column": {"id": "column:2", "name": ""}, "newColumn": "length"},
        },
    ],
    ids=lambda step: str(step["id"]),
)
def test_protocol_v2_accepts_canonical_column_references(step: dict) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": f"preview-{step['id']}",
        "priority": "interactive",
        "request": {
            "kind": "previewStep",
            "sessionId": "session-1",
            "revision": 0,
            "step": step,
            "offset": 0,
            "limit": 200,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    }

    assert decode_envelope(envelope)[2]["step"] == step


@pytest.mark.parametrize(
    ("step", "message"),
    [
        (
            {"id": "select-string", "kind": "selectColumns", "params": {"columns": ["value"]}},
            "column reference object",
        ),
        (
            {"id": "drop-empty", "kind": "dropColumns", "params": {"columns": []}},
            "non-empty array of column references",
        ),
        (
            {
                "id": "rename-string",
                "kind": "renameColumn",
                "params": {"column": "value", "newName": "amount"},
            },
            "column reference object",
        ),
        (
            {
                "id": "clone-name-only",
                "kind": "cloneColumn",
                "params": {"column": {"name": "value"}, "newName": "copy"},
            },
            "missing required fields: id",
        ),
        (
            {
                "id": "cast-id-only",
                "kind": "castColumn",
                "params": {"column": {"id": "column:0"}, "dtype": "float"},
            },
            "missing required fields: name",
        ),
        (
            {
                "id": "formula-string",
                "kind": "formula",
                "params": {
                    "leftColumn": "value",
                    "operator": "add",
                    "rightColumn": "other",
                    "newColumn": "total",
                },
            },
            "column reference object",
        ),
        (
            {
                "id": "length-extra",
                "kind": "textLength",
                "params": {
                    "column": {"id": "column:0", "name": "value", "position": 0},
                    "newColumn": "length",
                },
            },
            "unknown fields: position",
        ),
        (
            {
                "id": "length-empty-id",
                "kind": "textLength",
                "params": {"column": {"id": "", "name": "value"}, "newColumn": "length"},
            },
            "id must be a non-empty string",
        ),
        (
            {
                "id": "length-non-string-name",
                "kind": "textLength",
                "params": {"column": {"id": "column:0", "name": 42}, "newColumn": "length"},
            },
            "name must be a string",
        ),
        (
            {
                "id": "rename-name-field",
                "kind": "renameColumn",
                "params": {"columnName": "value", "newName": "amount"},
            },
            "missing required parameters: column",
        ),
    ],
)
def test_protocol_v2_rejects_legacy_or_malformed_column_references(step: dict, message: str) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": f"preview-{step['id']}",
        "priority": "interactive",
        "request": {
            "kind": "previewStep",
            "sessionId": "session-1",
            "revision": 0,
            "step": step,
            "offset": 0,
            "limit": 200,
            "columnOffset": 0,
            "columnLimit": 64,
        },
    }

    with pytest.raises(ProtocolError, match=message):
        decode_envelope(envelope)


def test_protocol_v2_validates_applied_step_inspection() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "inspect-1",
        "priority": "interactive",
        "request": {
            "kind": "inspectStep",
            "sessionId": "session-1",
            "revision": 2,
            "stepId": "round-value",
            "offset": 20,
            "limit": 10,
            "columnOffset": 4,
            "columnLimit": 6,
        },
    }

    assert decode_envelope(envelope)[2] == envelope["request"]
    envelope["request"]["limit"] = 10_000
    assert decode_envelope(envelope)[2]["limit"] == 10_000

    envelope["request"]["limit"] = 10_001
    with pytest.raises(ProtocolError, match="inspectStep limit must not exceed 10000"):
        decode_envelope(envelope)

    envelope["request"]["limit"] = 10
    envelope["request"]["stepId"] = ""
    with pytest.raises(ProtocolError, match="stepId must be a non-empty string"):
        decode_envelope(envelope)

    envelope["request"]["stepId"] = "round-value"
    envelope["request"]["unexpected"] = True
    with pytest.raises(ProtocolError, match="unknown fields"):
        decode_envelope(envelope)


def test_protocol_v2_rejects_malformed_transformation_steps() -> None:
    with pytest.raises(ProtocolError, match="missing required"):
        decode_envelope(
            {
                "protocolVersion": 2,
                "requestId": "preview-bad",
                "priority": "interactive",
                "request": {
                    "kind": "previewStep",
                    "sessionId": "session-1",
                    "revision": 0,
                    "step": {
                        "id": "rename-1",
                        "kind": "renameColumn",
                        "params": {"column": {"id": "column:0", "name": "old"}},
                    },
                    "offset": 0,
                    "limit": 200,
                    "columnOffset": 0,
                    "columnLimit": 64,
                },
            }
        )


def test_protocol_v2_validates_export_format() -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "export-1",
        "priority": "interactive",
        "request": {
            "kind": "exportData",
            "sessionId": "session-1",
            "revision": 2,
            "path": "/tmp/cleaned.csv",
            "options": {
                "format": "csv",
                "delimiter": ";",
                "quoteChar": "'",
                "encoding": "latin-1",
                "header": False,
                "rowAxisPolicy": "preserve",
            },
            "targetIdentity": {"device": "7", "inode": "11"},
        },
    }
    assert decode_envelope(envelope)[2]["options"] == {
        "format": "csv",
        "delimiter": ";",
        "quoteChar": "'",
        "encoding": "latin-1",
        "header": False,
        "rowAxisPolicy": "preserve",
    }
    envelope["request"]["options"]["format"] = "xlsx"
    with pytest.raises(ProtocolError, match="csv or parquet"):
        decode_envelope(envelope)
    envelope["request"]["options"]["format"] = "csv"
    envelope["request"]["options"]["rowAxisPolicy"] = "automatic"
    with pytest.raises(ProtocolError, match="rowAxisPolicy must be preserve or omit"):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    "options, message",
    [
        ({"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "utf-8"}, "header"),
        (
            {"format": "csv", "delimiter": "::", "quoteChar": '"', "encoding": "utf-8", "header": True},
            "delimiter",
        ),
        (
            {"format": "csv", "delimiter": ",", "quoteChar": ",", "encoding": "utf-8", "header": True},
            "must differ",
        ),
        (
            {"format": "csv", "delimiter": "\n", "quoteChar": '"', "encoding": "utf-8", "header": True},
            "non-NUL, non-line-break",
        ),
        (
            {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": " ", "header": True},
            "encoding",
        ),
        (
            {"format": "csv", "delimiter": ",", "quoteChar": '"', "encoding": "x" * 65, "header": True},
            "at most 64",
        ),
        (
            {"format": "parquet", "delimiter": ","},
            "invalid for parquet",
        ),
        (
            {"format": "parquet", "rowAxisPolicy": []},
            "rowAxisPolicy",
        ),
    ],
)
def test_protocol_v2_rejects_incomplete_or_cross_format_export_options(options, message) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "export-options-invalid",
        "priority": "interactive",
        "request": {
            "kind": "exportData",
            "sessionId": "session-1",
            "revision": 2,
            "path": "/tmp/.openwrangler-target.tmp",
            "options": options,
            "targetIdentity": {"device": "7", "inode": "11"},
        },
    }
    with pytest.raises(ProtocolError, match=message):
        decode_envelope(envelope)


@pytest.mark.parametrize(
    "identity",
    [
        None,
        {},
        {"device": "7"},
        {"device": "7", "inode": "11", "extra": "1"},
        {"device": "", "inode": "11"},
        {"device": "01", "inode": "11"},
        {"device": "0", "inode": "0"},
        {"device": str(1 << 128), "inode": "11"},
    ],
)
def test_protocol_v2_requires_the_host_owned_export_target_identity(identity) -> None:
    envelope = {
        "protocolVersion": 2,
        "requestId": "export-target-1",
        "priority": "interactive",
        "request": {
            "kind": "exportData",
            "sessionId": "session-1",
            "revision": 2,
            "path": "/tmp/.openwrangler-target.tmp",
            "options": {
                "format": "csv",
                "delimiter": ",",
                "quoteChar": '"',
                "encoding": "utf-8",
                "header": True,
            },
            "targetIdentity": identity,
        },
    }
    with pytest.raises(ProtocolError, match="targetIdentity|unsigned 128-bit|usable"):
        decode_envelope(envelope)


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
