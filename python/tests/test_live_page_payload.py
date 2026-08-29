from __future__ import annotations

import json
from typing import Any

import pytest

import openwrangler_runtime.live_page_payload as live_page_payload
from openwrangler_runtime.live_page_payload import LivePagePayloadError, validate_live_page_payload


def page_for(*cells: dict[str, Any], row_label: Any = None) -> dict[str, Any]:
    row: dict[str, Any] = {"id": "r:0", "rowNumber": 0, "values": list(cells)}
    if row_label is not None:
        row["rowLabel"] = row_label
    return {
        "offset": 0,
        "limit": 1,
        "totalRows": 1,
        "columnIds": [f"c:{index}" for index in range(len(cells))],
        "rows": [row],
    }


def cell(raw: Any, *, kind: str = "list", display: str = "value") -> dict[str, Any]:
    return {
        "kind": kind,
        "raw": raw,
        "display": display,
        "isNull": False,
        "isNaN": False,
    }


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (None, "malformed page payload"),
        ({"columnIds": (), "rows": []}, "malformed rows or column identities"),
        ({"columnIds": [], "rows": ()}, "malformed rows or column identities"),
        ({"columnIds": [], "rows": [None]}, "malformed row payload"),
        ({"columnIds": [], "rows": [{"id": "r:0", "values": ()}]}, "malformed row values"),
        ({"columnIds": ["c:0"], "rows": [{"id": "r:0", "values": [None]}]}, "malformed typed cell"),
    ],
)
def test_live_page_shape_boundary_rejects_malformed_values(payload: object, message: str) -> None:
    with pytest.raises(LivePagePayloadError, match=message):
        validate_live_page_payload(payload)


def test_live_page_budget_rejects_cells_nodes_depth_cycles_and_invalid_utf8(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_CELL_LIMIT", 1)
    with pytest.raises(LivePagePayloadError, match="at most 1 cells"):
        validate_live_page_payload(page_for(cell(1, kind="integer"), cell(2, kind="integer")))

    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_CELL_LIMIT", 100_000)
    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_COMPLEX_NODE_LIMIT", 3)
    with pytest.raises(LivePagePayloadError, match="at most 3 JSON nodes"):
        validate_live_page_payload(page_for(cell([1, 2, 3])))

    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_COMPLEX_NODE_LIMIT", 100_000)
    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_COMPLEX_DEPTH_LIMIT", 2)
    with pytest.raises(LivePagePayloadError, match="at most 2 nested levels"):
        validate_live_page_payload(page_for(cell([[[0]]])))

    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_COMPLEX_DEPTH_LIMIT", 64)
    cyclic: list[Any] = []
    cyclic.append(cyclic)
    with pytest.raises(LivePagePayloadError, match="cyclic containers"):
        validate_live_page_payload(page_for(cell(cyclic)))

    with pytest.raises(LivePagePayloadError, match="valid strict UTF-8"):
        validate_live_page_payload(page_for(cell("\ud800", kind="string", display="\ud800")))


def test_live_page_text_and_row_label_limits_are_distinct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_TEXT_CHARACTER_LIMIT", 4)
    with pytest.raises(LivePagePayloadError, match="at most 4 Unicode code points"):
        validate_live_page_payload(page_for(cell("valid", kind="string", display="large")))

    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_TEXT_CHARACTER_LIMIT", 65_536)
    assert validate_live_page_payload(page_for(cell("ok", kind="string", display="ok"), row_label="r" * 1_024)) > 0
    with pytest.raises(LivePagePayloadError, match="row labels may contain at most 1,024 Unicode code points"):
        validate_live_page_payload(page_for(cell("ok", kind="string", display="ok"), row_label="r" * 1_025))
    with pytest.raises(LivePagePayloadError, match="malformed row label"):
        validate_live_page_payload(page_for(cell("ok", kind="string", display="ok"), row_label=1))


def test_live_page_protocol_byte_limit_accepts_the_exact_multibyte_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    page = page_for(cell("é😀", kind="string", display="é😀"), row_label="é")
    exact_size = validate_live_page_payload(page)
    assert exact_size == len(
        json.dumps(page, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    )

    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_PROTOCOL_BYTE_LIMIT", exact_size)
    assert validate_live_page_payload(page) == exact_size
    monkeypatch.setattr(live_page_payload, "LIVE_PAGE_PROTOCOL_BYTE_LIMIT", exact_size - 1)
    with pytest.raises(LivePagePayloadError, match=f"at most {exact_size - 1:,} strict UTF-8 JSON bytes"):
        validate_live_page_payload(page)
