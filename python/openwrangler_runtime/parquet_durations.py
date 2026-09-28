"""Read and write the Arrow schema metadata that marks Parquet Duration columns.

Arrow writers, including Pandas and Polars, store a Duration column as a plain INT64 Parquet column and record its
unit only in the ``ARROW:schema`` key-value metadata: a base64 IPC ``Schema`` message encoded as a FlatBuffer.
Pandas, Polars and R read that metadata and restore the durations, while DuckDB reads the stored integers. This
module finds top-level Duration fields in that message and writes the message for DuckDB's own Parquet exports,
without depending on Arrow.
"""

from __future__ import annotations

import base64
import binascii
import struct
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import partial
from typing import Any

ARROW_SCHEMA_KEY = b"ARROW:schema"
MAX_ARROW_SCHEMA_BYTES = 8 * 1024 * 1024

_CONTINUATION = 0xFFFFFFFF
_METADATA_VERSION_V5 = 4
_MESSAGE_HEADER_SCHEMA = 1
_TYPE_INT = 2
_TYPE_FLOATING_POINT = 3
_TYPE_BINARY = 4
_TYPE_UTF8 = 5
_TYPE_BOOL = 6
_TYPE_DECIMAL = 7
_TYPE_DATE = 8
_TYPE_TIME = 9
_TYPE_TIMESTAMP = 10
_TYPE_LIST = 12
_TYPE_STRUCT = 13
_TYPE_DURATION = 18
_TIME_UNITS = {0: "s", 1: "ms", 2: "us", 3: "ns"}
_TIME_UNIT_CODES = {unit: code for code, unit in _TIME_UNITS.items()}
_DEFAULT_TIME_UNIT = 1
_FLOAT_PRECISIONS = {16: 0, 32: 1, 64: 2}


class _FlatBuffer:
    def __init__(self, data: bytes) -> None:
        self._data = data

    def _read(self, layout: str, position: int) -> int:
        if position < 0 or position + struct.calcsize(layout) > len(self._data):
            raise ValueError("The Arrow schema metadata is truncated.")
        return struct.unpack_from(layout, self._data, position)[0]

    def u8(self, position: int) -> int:
        return self._read("<B", position)

    def i16(self, position: int) -> int:
        return self._read("<h", position)

    def u32(self, position: int) -> int:
        return self._read("<I", position)

    def target(self, position: int) -> int:
        return position + self.u32(position)

    def field(self, table: int, index: int) -> int | None:
        vtable = table - self._read("<i", table)
        entry = 4 + 2 * index
        if entry + 2 > self._read("<H", vtable):
            return None
        offset = self._read("<H", vtable + entry)
        return table + offset if offset else None

    def text(self, position: int) -> str:
        length = self.u32(position)
        if position + 4 + length > len(self._data):
            raise ValueError("The Arrow schema metadata is truncated.")
        return self._data[position + 4 : position + 4 + length].decode("utf-8")

    def vector(self, position: int) -> list[int]:
        count = self.u32(position)
        if position + 4 + 4 * count > len(self._data):
            raise ValueError("The Arrow schema metadata is truncated.")
        return [self.target(position + 4 + 4 * index) for index in range(count)]


def _top_level_fields(message: bytes) -> list[tuple[str, str | None]]:
    envelope = _FlatBuffer(message)
    start = 4 if envelope.u32(0) == _CONTINUATION else 0
    length = envelope.u32(start)
    start += 4
    if length == 0 or start + length > len(message):
        raise ValueError("The Arrow schema metadata is truncated.")
    buffer = _FlatBuffer(message[start : start + length])
    root = buffer.target(0)
    header_type = buffer.field(root, 1)
    header = buffer.field(root, 2)
    if header_type is None or header is None or buffer.u8(header_type) != _MESSAGE_HEADER_SCHEMA:
        raise ValueError("The Arrow schema metadata is not a schema message.")
    schema = buffer.target(header)
    fields = buffer.field(schema, 1)
    if fields is None:
        return []
    result: list[tuple[str, str | None]] = []
    for field in buffer.vector(buffer.target(fields)):
        name = buffer.field(field, 0)
        type_type = buffer.field(field, 2)
        unit = None
        if type_type is not None and buffer.u8(type_type) == _TYPE_DURATION and buffer.field(field, 4) is None:
            duration_type = buffer.field(field, 3)
            if duration_type is None:
                raise ValueError("The Arrow schema metadata has a Duration field without a type.")
            unit_field = buffer.field(buffer.target(duration_type), 0)
            code = _DEFAULT_TIME_UNIT if unit_field is None else buffer.i16(unit_field)
            if code not in _TIME_UNITS:
                raise ValueError("The Arrow schema metadata has an unknown Duration unit.")
            unit = _TIME_UNITS[code]
        result.append(("" if name is None else buffer.text(buffer.target(name)), unit))
    return result


def arrow_duration_units(metadata: bytes, column_names: Sequence[str]) -> dict[str, str]:
    """Map each top-level Duration column to its unit: ``s``, ``ms``, ``us`` or ``ns``.

    ``metadata`` is the ``ARROW:schema`` value and ``column_names`` the file's top-level columns in order. The result
    is empty unless the metadata decodes and names exactly those columns, so malformed or stale metadata leaves every
    column as stored.
    """
    if len(metadata) > MAX_ARROW_SCHEMA_BYTES:
        return {}
    try:
        fields = _top_level_fields(base64.b64decode(metadata, validate=True))
    except (binascii.Error, ValueError):
        return {}
    if [name for name, _unit in fields] != list(column_names):
        return {}
    return {name: unit for name, unit in fields if unit is not None}


# A table slot holds ``(layout, value)``: a ``struct`` scalar layout, or ``"ref"`` with a writer that appends the
# referenced object and returns its position.
_Slot = tuple[str, Any] | None


@dataclass(frozen=True)
class ArrowType:
    """One Arrow type: its ``Type`` union code, the slots of its type table and its child fields."""

    code: int
    slots: tuple[tuple[str, Any], ...] = ()
    children: tuple[tuple[str, ArrowType], ...] = ()


ARROW_BOOL = ArrowType(_TYPE_BOOL)
ARROW_UTF8 = ArrowType(_TYPE_UTF8)
ARROW_BINARY = ArrowType(_TYPE_BINARY)
ARROW_DATE = ArrowType(_TYPE_DATE, (("h", 0),))


def arrow_integer(bits: int, signed: bool) -> ArrowType:
    return ArrowType(_TYPE_INT, (("i", bits), ("?", signed)))


def arrow_float(bits: int) -> ArrowType:
    return ArrowType(_TYPE_FLOATING_POINT, (("h", _FLOAT_PRECISIONS[bits]),))


def arrow_decimal(precision: int, scale: int) -> ArrowType:
    return ArrowType(_TYPE_DECIMAL, (("i", precision), ("i", scale), ("i", 128)))


def arrow_time(unit: str) -> ArrowType:
    return ArrowType(_TYPE_TIME, (("h", _TIME_UNIT_CODES[unit]), ("i", 64 if unit in {"us", "ns"} else 32)))


def arrow_timestamp(unit: str, timezone: str | None = None) -> ArrowType:
    slots: tuple[tuple[str, Any], ...] = (("h", _TIME_UNIT_CODES[unit]),)
    return ArrowType(_TYPE_TIMESTAMP, slots if timezone is None else (*slots, ("str", timezone)))


def arrow_duration(unit: str) -> ArrowType:
    return ArrowType(_TYPE_DURATION, (("h", _TIME_UNIT_CODES[unit]),))


def arrow_list(child: ArrowType) -> ArrowType:
    return ArrowType(_TYPE_LIST, children=(("element", child),))


def arrow_struct(fields: Sequence[tuple[str, ArrowType]]) -> ArrowType:
    return ArrowType(_TYPE_STRUCT, children=tuple(fields))


class _FlatBufferWriter:
    """Lays FlatBuffer objects out front to back, so every unsigned offset points forward as the format requires."""

    _SIZES = {"ref": 4, "str": 4, "i": 4, "h": 2, "B": 1, "?": 1}

    def __init__(self) -> None:
        self.data = bytearray(4)

    def _align(self, size: int) -> None:
        self.data.extend(bytes(-len(self.data) % size))

    def _point(self, slot: int, target: int) -> None:
        struct.pack_into("<I", self.data, slot, target - slot)

    def root(self, write: Callable[[], int]) -> bytes:
        self._point(0, write())
        return bytes(self.data)

    def table(self, slots: Sequence[_Slot]) -> int:
        present = [(index, slot) for index, slot in enumerate(slots) if slot is not None]
        # Wider fields first keep each field aligned after the table's 4-byte vtable offset.
        offsets: dict[int, int] = {}
        size = 4
        for index, (layout, _value) in sorted(present, key=lambda item: -self._SIZES[item[1][0]]):
            offsets[index] = size
            size += self._SIZES[layout]
        self._align(4)
        vtable = len(self.data)
        self.data += struct.pack(
            f"<HH{len(slots)}H", 4 + 2 * len(slots), size, *(offsets.get(index, 0) for index in range(len(slots)))
        )
        self._align(4)
        table = len(self.data)
        self.data += struct.pack("<i", table - vtable) + bytes(size - 4)
        references = []
        for index, (layout, value) in present:
            if layout == "ref":
                references.append((table + offsets[index], value))
            elif layout == "str":
                references.append((table + offsets[index], partial(self.string, value)))
            else:
                struct.pack_into("<" + layout, self.data, table + offsets[index], value)
        for slot, write in references:
            self._point(slot, write())
        return table

    def string(self, text: str) -> int:
        encoded = text.encode("utf-8")
        self._align(4)
        position = len(self.data)
        self.data += struct.pack("<I", len(encoded)) + encoded + b"\0"
        return position

    def vector(self, writers: Sequence[Callable[[], int]]) -> int:
        self._align(4)
        position = len(self.data)
        self.data += struct.pack("<I", len(writers)) + bytes(4 * len(writers))
        for index, write in enumerate(writers):
            self._point(position + 4 + 4 * index, write())
        return position

    def field(self, name: str, arrow_type: ArrowType) -> int:
        children = [partial(self.field, child_name, child) for child_name, child in arrow_type.children]
        return self.table(
            [
                ("str", name),
                ("?", True),
                ("B", arrow_type.code),
                ("ref", partial(self.table, arrow_type.slots)),
                None,
                ("ref", partial(self.vector, children)),
            ]
        )


def arrow_schema_metadata(fields: Sequence[tuple[str, ArrowType]]) -> str:
    """The base64 ``ARROW:schema`` value declaring ``fields`` as nullable top-level columns, in order."""

    writer = _FlatBufferWriter()
    columns = [partial(writer.field, name, arrow_type) for name, arrow_type in fields]
    schema = partial(writer.table, [("h", 0), ("ref", partial(writer.vector, columns))])
    message = writer.root(
        partial(writer.table, [("h", _METADATA_VERSION_V5), ("B", _MESSAGE_HEADER_SCHEMA), ("ref", schema)])
    )
    message += bytes(-len(message) % 8)
    return base64.b64encode(struct.pack("<Ii", _CONTINUATION, len(message)) + message).decode("ascii")
